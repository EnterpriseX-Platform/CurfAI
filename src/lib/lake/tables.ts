/**
 * Lake table CRUD — create, append, replace, drop, list, query, preview.
 *
 * Schema model: every column is stored as TEXT in SQLite. Type info lives
 * in the `__lake_meta.source_config_json` blob and the LakeTable Prisma
 * row's schemaJson, which the runner consults to coerce on read. Why
 * untyped storage? Two reasons:
 *
 *   1. JSON ingestion (the dominant Phase 1 path) is naturally typed at
 *      read time anyway — webhook payload `{"amount": 12.34}` lands the
 *      same regardless of whether we declared REAL or TEXT.
 *   2. Schema drift handling becomes trivial — a new column shows up,
 *      we add it as TEXT, no ALTER-with-cast dance, no parser-level
 *      rejection of mismatched types.
 *
 * The trade-off is that the report runner has to coerce on read. Cheap
 * and well-bounded. We can revisit when we have a real performance budget
 * pinned to a typed-storage win.
 */
import type Database from "better-sqlite3";
import { openLake, toSafeTableName } from "./storage";
import { runLakeRead, runLakeTransaction, type LakeStatement } from "./lakeWorker";
import { isNullToken, meansNull, detectCellType, cleanForType, detectDateOrder, type CellType, type DateOrder } from "./valueClean";
import { ee } from "@/ee";
import { TypedConversionDriftError, isTypedConversionDriftError } from "./typedConversionErrors";
import {
  addGeneratedColumn, allColumnNames, dependentsInOrder, formulaDependents, generatedColumnNames,
  readFormulas, reapplyFormulas, withFormulas, writeFormulas, FORMULAS_KEY, type StoredFormulas,
  renameInFormulas, assertNotReadByFormulas,
} from "./formulaColumns";
import { compileFormula, quoteIdent, type FormulaType } from "./formula/compile";
import { assertNewColumnName } from "./columnName";
// Re-exported so existing importers keep getting them from tables.ts.
export { TypedConversionDriftError, isTypedConversionDriftError };

// See storage.ts for why we alias the instance type instead of using `Database`
// directly — the default export is also a namespace, breaking direct type use.
type DB = InstanceType<typeof Database>;

/**
 * Quote a SQLite identifier, doubling any embedded `"`. Column names in the
 * bulk-ingest paths come straight from untrusted upload/webhook/CDC payload
 * keys; a name like `x" TEXT UNIQUE, "y` would otherwise break out of the
 * quotes and inject DDL. Legitimate names with spaces/hyphens are preserved
 * (autoCurf's own `q()` quotes them the same way on read).
 */
export const qIdent: (name: string) => string = quoteIdent;

// Re-export so callers can import the helper from tables.ts (the canonical
// table-mutation surface) without reaching into storage.ts.
export { toSafeTableName };

export type LakeColumn = {
  name: string;
  /** Inferred type, used by the runner for coercion + the UI for display. */
  type: "text" | "number" | "boolean" | "date" | "unknown";
  /** Sample value the inference came from. Helps debugging. */
  sample?: string | number | boolean | null;
  /**
   * For `date` columns only: which way round a slash date reads. Set by
   * detectDateOrder over the whole column at ingest, or by the user in the
   * upload preview when the column offered no proof either way. Carried on
   * the schema so a later retype re-cleans the same way the import did.
   */
  dateOrder?: DateOrder;
  /**
   * Optional sensitivity classification for column-level redaction (Phase 3).
   * When set, the runner masks the column's values to viewers whose role
   * isn't in the column's allowlist (LakeColumnSensitivity rules). Default
   * undefined = treat as ordinary, no redaction applied.
   *
   *   pii        — directly identifies a person (email, phone, SSN-ish)
   *   financial  — payment / banking / earnings detail
   *   health     — medical records / conditions / prescriptions
   *   secret     — bearer tokens, API keys (rarely lands in lake but happens)
   */
  sensitivity?: "pii" | "financial" | "health" | "secret";
  /**
   * Role slugs that are allowed to see the unredacted value. Empty/missing
   * means "no role can see it — always redact" (the strictest default).
   * Tenant admins always see the underlying values regardless — tag the
   * column with sensitivity to opt in to redaction, then add roles to
   * the allowlist as you approve them.
   */
  unredactedForRoles?: string[];
  /**
   * What a code column's values mean in each language — stock status "reorder"
   * is "ควรสั่ง" to a Thai reader. Generated reports select the column through
   * these labels (and match a drill on them), so a reader never sees the code.
   */
  valueLabels?: Partial<Record<"en" | "th" | "zh", Record<string, string>>>;
  /**
   * How the column's numbers read, when its name would mislead a guess:
   * avg_daily_sales counts items a day, not baht. Generated reports format
   * the column by this before guessing from the name.
   */
  format?: "number" | "currency" | "percent";
  /**
   * Master Builder's plan-time `fk:<table>` hint (BuildTablePlan.columns[]
   * .syntheticHint), carried onto the persisted schema so downstream code
   * doesn't need the plan anymore to know a relationship exists — see
   * autoCurfMulti.ts's discoverJoins() (B7), which prefers this over
   * guessing a join from `<dim>_id` column naming. Schema-drift-added
   * columns already carried this through mergeSchemaJson(); this is the
   * same field, just also populated at initial table creation.
   */
  syntheticHint?: string;
  /**
   * Set on a formula column: the formula as the person wrote it (see
   * lib/lake/formulaColumns.ts). The engine computes the values; the
   * column's `type` is what the formula gives, and its redaction tags follow
   * the columns it reads (lib/lake/schemaGovernance.ts withFormulaGovernance).
   */
  formula?: string;
};

/**
 * E1b Phase A (E1B_TYPED_COLUMNS_SCOPING_PLAN.md) — label → physical SQLite
 * DDL type. Not called by anything yet: every column is still declared TEXT
 * regardless of this mapping (see this file's own header comment on why,
 * and coerceForStorage's comment on the SQLite-affinity incident that
 * happened the one time a native value was bound unstringified). Exists now
 * so Phase B has a settled, reviewed answer to "what DDL type" before any
 * write path changes.
 *
 * Design mirrors an already-shipped precedent in this codebase —
 * lib/connections/excelImport.ts's sqlTypeFor(), used today for the
 * Excel→SQLite import connector (a different LogicalType label set, hence
 * a fresh function here rather than importing that one directly):
 *   - boolean → INTEGER (0/1) — SQLite has no native boolean storage class.
 *   - date → TEXT (ISO, sortable lexically) — SQLite has no native date
 *     storage class either; TEXT is the idiomatic choice, not a compromise.
 *   - number → REAL — the lake's type system doesn't distinguish integer
 *     from decimal (unlike excelImport's own INTEGER/REAL split), and REAL
 *     safely represents both; every existing CAST(... AS REAL) site
 *     downstream already assumes this is the numeric type lake columns
 *     resolve to.
 */
export function sqlTypeForLakeColumn(type: LakeColumn["type"]): string {
  switch (type) {
    case "number": return "REAL";
    case "boolean": return "INTEGER";
    case "date": return "TEXT";
    case "text":
    case "unknown":
    default: return "TEXT";
  }
}

/**
 * E1b Phase C (E1B_TYPED_COLUMNS_SCOPING_PLAN.md) — the reverse of
 * sqlTypeForLakeColumn: given a column's ACTUAL declared DDL type (read
 * back via PRAGMA table_info, not assumed), decide how appendRows /
 * upsertLakeRowsByKey should coerce a value being written into it. Only
 * two DDL types round-trip to something other than plain string
 * passthrough — REAL (→"number") and INTEGER (→"boolean"), the only two
 * non-TEXT types sqlTypeForLakeColumn ever emits today. "date" and
 * "text"/"unknown" are indistinguishable here on purpose: both mean
 * "this column is TEXT," and coerceForTypedStorage's date/text/unknown
 * cases already do the exact same thing (delegate to coerceForStorage) —
 * no need to tell them apart just to coerce a value the same way either
 * answer would.
 *
 * This asks the table what it actually is instead of trusting a
 * separately-stored "is this table typed" marker, which is deliberate:
 * a table can have a per-column mix (created typed under Phase B, then
 * had a column added later via addColumn/appendRows' own schema-drift
 * path, which always adds TEXT regardless of this flag — see
 * typedColumnsEnabled's doc comment on why that path is untouched). A
 * table-level marker can't represent that; asking each column what it
 * is, every time, always can.
 */
/**
 * How each stored column of a SQLite lake table is declared (TEXT, REAL, …),
 * upper-cased, by name. Formula columns aren't stored, so they aren't listed.
 * For callers that need the storage itself, not the catalog's reading of it
 * (textNumbers.ts: is this "number" column still TEXT underneath?).
 */
export function storedColumnTypes(tenantId: string, tableName: string): Map<string, string> {
  const rows = openLake(tenantId).prepare(`PRAGMA table_info("${toSafeTableName(tableName)}")`).all() as Array<{ name: string; type: string }>;
  return new Map(rows.map((c) => [c.name, c.type.toUpperCase()]));
}

export function lakeTypeFromSqlDdl(ddlType: string): LakeColumn["type"] {
  const t = ddlType.toUpperCase();
  if (t === "REAL") return "number";
  if (t === "INTEGER") return "boolean";
  return "text";
}

export type LakeTableMeta = {
  name: string;
  columns: LakeColumn[];
  rowCount: number;
  sourceKind: "upload" | "webhook" | "rest_pull" | "sftp_pull" | "manual";
  sourceConfig?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

/**
 * Infer column types from a sample of rows, by majority vote rather than
 * first-mismatch-wins.
 *
 * The old rule called a column "text" the moment ANY sampled cell disagreed
 * with the first non-null value's type — so a single stray "N/A" among
 * 50,000 clean numbers, or one "$" formatted price among plain ones, made
 * the whole column untypeable (and therefore unchartable — every generated
 * KPI/chart in autoCurf.ts and autoCurfMulti.ts filters columns by exactly
 * this type field). Real spreadsheets are never perfectly uniform, so that
 * rule mistyped the common case, not the edge case.
 *
 * Now: null-like tokens ("N/A", "-", "TBD", …) are excluded from the vote
 * entirely rather than counted as a type disagreement (see isNullToken()).
 * Each remaining cell is classified with detectCellType(), which — unlike
 * the old bare-regex test — understands currency symbols, thousands
 * separators, percent signs, and common date formats. A non-text type wins
 * the column only when it holds a clear supermajority of the votes
 * (TYPE_VOTE_THRESHOLD); anything short of that falls back to "text",
 * which never loses information. A genuinely mixed column (numbers AND
 * words) still correctly lands on "text" — this fixes the common case
 * without pretending to resolve genuine ambiguity.
 */
export const TYPE_VOTE_THRESHOLD = 0.9;
/** Bounded sample size for both column discovery and the type vote — wide
 *  enough to survive a run of blanks at the top of a column (the old 100/200
 *  split under-sampled short-tailed columns), still cheap for a 50k-row file. */
const INFER_SAMPLE_SIZE = 500;

export function inferColumns(rows: any[]): LakeColumn[] {
  if (rows.length === 0) return [];
  const scanRows = rows.slice(0, INFER_SAMPLE_SIZE);
  const colNames = new Set<string>();
  for (const r of scanRows) {
    if (r && typeof r === "object") for (const k of Object.keys(r)) colNames.add(k);
  }
  const out: LakeColumn[] = [];
  for (const name of colNames) {
    const counts: Record<CellType, number> = { text: 0, number: 0, boolean: 0, date: 0, unknown: 0 };
    let sample: any = null;
    let total = 0;
    for (const r of scanRows) {
      const v = r?.[name];
      if (v == null || v === "") continue;
      if (typeof v === "string" && isNullToken(v)) continue;
      if (sample == null) sample = v;
      const t = typeOf(v);
      counts[t] += 1;
      total += 1;
    }
    if (total === 0) { out.push({ name, type: "unknown", sample: null }); continue; }
    let best: CellType = "text";
    let bestCount = -1;
    for (const t of ["number", "date", "boolean", "text"] as CellType[]) {
      if (counts[t] > bestCount) { best = t; bestCount = counts[t]; }
    }
    const type: LakeColumn["type"] = best !== "text" && bestCount / total >= TYPE_VOTE_THRESHOLD ? best : "text";
    if (type === "date") {
      // Day-first or month-first is a property of the COLUMN, not of any
      // one cell, so it's decided here over the whole sample and carried
      // on the column for cleanRowsForColumns to apply uniformly.
      const strings: string[] = [];
      for (const r of scanRows) { const v = r?.[name]; if (typeof v === "string") strings.push(v); }
      const { order } = detectDateOrder(strings);
      out.push({ name, type, sample, dateOrder: order });
      continue;
    }
    out.push({ name, type, sample });
  }
  return out;
}

/**
 * Classify one already-typed JS value (number/boolean/string/etc — the
 * shape rows arrive in from JSON ingestion) into a vote bucket. String
 * values are delegated to valueClean's detectCellType(), which does the
 * real work of recognising a formatted number/date inside a string; native
 * JS types short-circuit straight to their bucket since there's nothing to
 * parse.
 */
function typeOf(v: unknown): CellType {
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "string") return detectCellType(v);
  return "text";
}

/**
 * Apply each column's DECIDED type to every raw cell before it's written to
 * disk — the write-time half of the fix. Classifying a column "number"
 * without also cleaning "$1,299.00" down to "1299" is cosmetic: every
 * generated aggregate does SUM(CAST(col AS REAL)), and SQLite's CAST-to-REAL
 * returns 0 for a string that doesn't start with a digit, so the KPI would
 * silently compute 0 no matter what the type label said.
 *
 * Only STRING cells are touched — a JSON-sourced number or boolean is
 * already in native form and skips straight through; only the upload/CSV/
 * webhook-as-strings path needs text cleaning. Returns a NEW array; input
 * rows are never mutated (callers may reuse them for a receipt/log).
 */
export function cleanRowsForColumns(
  rows: Array<Record<string, unknown>>,
  columns: LakeColumn[],
): Array<Record<string, unknown>> {
  if (columns.length === 0) return rows;
  return rows.map((r) => {
    if (!r || typeof r !== "object") return r;
    const out: Record<string, unknown> = { ...r };
    for (const c of columns) {
      const v = out[c.name];
      if (typeof v !== "string") continue;
      if (meansNull(v, c.type)) { out[c.name] = null; continue; }
      out[c.name] = cleanForType(v, c.type, { dateOrder: c.dateOrder });
    }
    return out;
  });
}

/**
 * Pure column-resolution shared by both engines' createOrReplaceTable:
 * infer from the rows, apply Master Builder's syntheticHints, apply the
 * user's upload-preview type overrides, then resolve each date column's
 * day/month order. Extracted so a DuckDB-engine tenant's create path
 * (lib/lake/engine/duckdbWrite.ts) applies the exact same rules instead
 * of a second, independently-maintained copy that could drift.
 */
export function resolveColumnsForCreate(
  rows: Array<Record<string, unknown>>,
  opts: {
    columnHints?: Record<string, string>;
    columnTypeOverrides?: Record<string, LakeColumn["type"]>;
    columnDateOrders?: Record<string, DateOrder>;
  },
): LakeColumn[] {
  const columns = inferColumns(rows);
  if (opts.columnHints) {
    for (const c of columns) {
      const hint = opts.columnHints[c.name];
      if (hint) c.syntheticHint = hint;
    }
  }
  if (opts.columnTypeOverrides) {
    for (const c of columns) {
      const override = opts.columnTypeOverrides[c.name];
      if (override) c.type = override;
    }
  }
  for (const c of columns) {
    if (c.type !== "date") { c.dateOrder = undefined; continue; }
    const chosen = opts.columnDateOrders?.[c.name];
    if (chosen) c.dateOrder = chosen;
    // A column the user just retyped INTO date never went through the
    // detector, so read its order from the rows now.
    else if (!c.dateOrder) {
      c.dateOrder = detectDateOrder(
        rows.map((r) => r?.[c.name]).filter((v): v is string => typeof v === "string"),
      ).order;
    }
  }
  return columns;
}

/**
 * Create a new table (or replace if exists) and seed with rows. Caller
 * is responsible for quota check before calling — this function just
 * trusts the inputs and writes them.
 *
 * Returns the inferred schema so the API layer can persist it on the
 * LakeTable Prisma row.
 */
export async function createOrReplaceTable(opts: {
  tenantId: string;
  tableName: string;
  rows: Array<Record<string, unknown>>;
  sourceKind: LakeTableMeta["sourceKind"];
  sourceConfig?: Record<string, unknown>;
  columnHints?: Record<string, string>;
  columnTypeOverrides?: Record<string, LakeColumn["type"]>;
  columnDateOrders?: Record<string, DateOrder>;
  /**
   * Force typed DDL for this call regardless of the CURF_LAKE_TYPED_COLUMNS
   * kill switch (typedColumnsEnabled()). Set by callers that fully
   * DROP+CREATE a derived table from a query result on every run — pipeline
   * steps (lib/lake/pipelines.ts) and materialized views (lib/lake/materialize.ts)
   * — never by an ingestion path. Those callers' rows come straight out of
   * the report runner (SUM(CAST(... AS DOUBLE)), etc.), which already hands
   * back real JS numbers/booleans/dates for aggregated columns; storing them
   * as TEXT anyway (the untyped-storage default this file's header explains)
   * silently drops that typing, so a LATER step or MV reading the output
   * with a plain numeric comparison (`total > 20000`) hits DuckDB's missing
   * VARCHAR→numeric coercion and fails with a raw Binder Error — reproduced
   * live against a DuckDB-migrated tenant chaining two pipeline steps.
   * Safe specifically because these callers never append/upsert into the
   * table they just typed (the Phase-C gap typedColumnsEnabled's own doc
   * comment warns about is about appendRows/upsertLakeRowsByKey, neither of
   * which pipelines/MVs ever call) — every refresh is a brand-new physical
   * table via the same DROP+CREATE below.
   */
  forceTypedColumns?: boolean;
  /**
   * The formula columns to declare on the new table. By default a replace
   * keeps the ones the table has now; a restore passes the snapshot's, so the
   * table comes back as it was (its rows must not hold those columns' values).
   */
  formulas?: StoredFormulas;
}): Promise<{
  columns: LakeColumn[];
  rowCount: number;
  safeName: string;
  /** Formula columns the table had that the new data can't carry (a column they read is gone). */
  droppedFormulas?: Array<{ name: string; reason: string }>;
}> {
  // A tenant on a paid lake engine (DuckDB) writes there instead of the
  // default per-tenant SQLite file — see ee.lake.createOrReplaceTableIfPaidEngine's
  // doc comment. null/absent means "this tenant is on the default engine",
  // so we fall through to the SQLite path below, unchanged from before
  // this function became async.
  const { tenantId, ...rest } = opts;
  const paid = await ee.lake?.createOrReplaceTableIfPaidEngine(tenantId, rest);
  if (paid != null) return paid;

  const db = openLake(opts.tenantId);
  const safeName = toSafeTableName(opts.tableName);
  const columns = resolveColumnsForCreate(opts.rows, opts);
  const cleanedRows = cleanRowsForColumns(opts.rows, columns);
  // E1b Phase B (E1B_TYPED_COLUMNS_SCOPING_PLAN.md) — off by default; see
  // typedColumnsEnabled's own doc comment for exactly what turning this on
  // does and doesn't cover. DROP+CREATE below makes every call to this
  // function a genuinely new physical table regardless of whether a
  // same-named one existed a moment ago, so "brand-new tables only" is
  // satisfied by this function's existing, unchanged semantics — no extra
  // existence check needed. opts.forceTypedColumns (see its doc comment)
  // overrides the kill switch for derived-table callers.
  const typed = opts.forceTypedColumns === true || typedColumnsEnabled();
  // Typed only where every value converts without loss; a column with stray cells stays TEXT (storageTypeFor).
  const stored = columns.map((c) => (typed ? storageTypeFor(c, cleanedRows) : "text"));
  const colDefs = columns.map((c, i) => `${qIdent(c.name)} ${typed ? sqlTypeForLakeColumn(stored[i]!) : "TEXT"}`).join(", ");
  // A replace keeps the table's formula columns: re-uploading orders.csv
  // shouldn't lose the formulas someone added to it.
  const priorFormulas = opts.formulas ?? readFormulas(db, safeName);
  let kept: StoredFormulas = {};
  let droppedFormulas: Array<{ name: string; reason: string }> = [];

  // Single transaction so a partial failure leaves nothing behind.
  const tx = db.transaction(() => {
    db.prepare(`DROP TABLE IF EXISTS "${safeName}"`).run();
    if (columns.length === 0) {
      // Empty input → create a placeholder table with one column. Lets
      // the user point at it from the UI even before there's data.
      db.prepare(`CREATE TABLE "${safeName}" ("_empty" TEXT)`).run();
    } else {
      db.prepare(`CREATE TABLE "${safeName}" (${colDefs})`).run();
      const insert = db.prepare(
        `INSERT INTO "${safeName}" (${columns.map((c) => qIdent(c.name)).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      );
      for (const r of cleanedRows) {
        insert.run(...columns.map((c, i) => (typed ? coerceForTypedStorage(r?.[c.name], stored[i]!) : coerceForStorage(r?.[c.name]))));
      }
      ({ kept, dropped: droppedFormulas } = reapplyFormulas(db, safeName, priorFormulas, columns));
    }
    upsertMeta(db, safeName, opts.sourceKind, withFormulas(withDateOrders(opts.sourceConfig, columns), kept), opts.rows.length);
  });
  tx();

  return {
    columns: [...columns, ...Object.entries(kept).map(([name, f]) => ({ name, type: f.type, formula: f.formula }))],
    rowCount: opts.rows.length,
    safeName,
    ...(droppedFormulas.length ? { droppedFormulas } : {}),
  };
}

/**
 * Append rows to an existing table, evolving the schema with new columns
 * via ALTER TABLE. Used by both webhook and scheduled-pull paths.
 *
 * A tenant on a paid lake engine (DuckDB) appends there instead of the
 * default per-tenant SQLite file — see ee.lake.appendRowsIfPaidEngine's
 * doc comment. null/absent means "this tenant is on the default engine",
 * so we fall through to the SQLite path below, unchanged from before this
 * function became async.
 */
export async function appendRows(opts: {
  tenantId: string;
  tableName: string;
  rows: Array<Record<string, unknown>>;
  /**
   * The table's column types when the caller already knows them — an
   * import that created this table moments ago from the types the user
   * confirmed in the upload preview (lib/lake/importJob.ts). Without it
   * each batch re-derives types from 100 stored rows, and a column the
   * user kept as text because its values only LOOK numeric would drift
   * back to number part-way through the file.
   */
  columns?: LakeColumn[];
}): Promise<{ added: number; newColumns: string[] }> {
  if (opts.rows.length === 0) return { added: 0, newColumns: [] };
  const paid = await ee.lake?.appendRowsIfPaidEngine(opts.tenantId, { tableName: opts.tableName, rows: opts.rows, columns: opts.columns });
  if (paid != null) return paid;

  const db = openLake(opts.tenantId);
  const safeName = toSafeTableName(opts.tableName);

  // Schema introspection: pull current columns, diff against the rows we
  // received. Any missing column triggers an ALTER TABLE ADD COLUMN.
  const existingColRows = db.prepare(`PRAGMA table_info("${safeName}")`).all() as Array<{ name: string; type: string }>;
  const existingCols = existingColRows.map((c) => c.name);
  // E1b Phase C (E1B_TYPED_COLUMNS_SCOPING_PLAN.md) — each existing
  // column's REAL declared DDL type, asked of the table directly rather
  // than assumed from a table-level flag. A column not in this map (one
  // this batch is about to ALTER in as brand new) is always TEXT — see
  // the ALTER below, unchanged by Phase C on purpose.
  const existingColDdlTypes = new Map(existingColRows.map((c) => [c.name, c.type]));
  if (existingCols.length === 0) {
    // Table doesn't exist — fall through to create-or-replace path.
    const { rowCount } = await createOrReplaceTable({
      tenantId: opts.tenantId,
      tableName: opts.tableName,
      rows: opts.rows,
      sourceKind: "webhook",
    });
    return { added: rowCount, newColumns: [] };
  }
  const incomingCols = new Set<string>();
  for (const r of opts.rows) for (const k of Object.keys(r ?? {})) incomingCols.add(k);
  // A formula column (left out of table_info) works itself out: a value
  // arriving under its name — a re-import of an export, say — isn't stored.
  const formulaCols = generatedColumnNames(db, safeName);
  const newCols = Array.from(incomingCols).filter((c) => !existingCols.includes(c) && !formulaCols.has(c));

  // Clean the incoming batch the same way createOrReplaceTable does — a
  // scheduled SFTP/REST pull runs the exact same string-typed CSV/XLSX
  // parser (parseFile.ts) an upload does, so it's exposed to the same
  // "$1,299.00" / "01/15/2024" formatting.
  //
  // Types come from the TABLE, not from the batch. A batch is a slice, and
  // a slice can look like something the column isn't: five rows of a
  // reference column that happen to be all-numeric get cleaned as numbers
  // and stop matching the rows around them, and a date batch with every
  // day ≤ 12 can pick the opposite day/month order from the one the table
  // was built with. The established schema is re-derived from stored rows
  // (already cleaned, so they read back as their true type); the batch
  // only decides columns the table doesn't have yet.
  const established = opts.columns ?? schemaForTable(db, safeName);
  const hasRows = (db.prepare(`SELECT 1 FROM "${safeName}" LIMIT 1`).get() as unknown) != null;
  const batchSchema = inferColumns(opts.rows);
  const merged = hasRows
    ? preferEstablishedColumns(established, batchSchema)
    : batchSchema;  // Nothing stored yet, so there's no established type to honour.
  const cleanedRows = cleanRowsForColumns(opts.rows, merged);

  const tx = db.transaction(() => {
    for (const c of newCols) {
      db.prepare(`ALTER TABLE "${safeName}" ADD COLUMN ${qIdent(c)} TEXT`).run();
    }
    const allCols = [...existingCols.filter((c) => c !== "_empty"), ...newCols];
    const insert = db.prepare(
      `INSERT INTO "${safeName}" (${allCols.map((c) => qIdent(c)).join(", ")}) VALUES (${allCols.map(() => "?").join(", ")})`,
    );
    for (const r of cleanedRows) {
      insert.run(...allCols.map((c) => {
        // A column this batch just ALTER'd in isn't in the map — always
        // TEXT, always the legacy coercion (see the ALTER above).
        const ddlType = existingColDdlTypes.get(c);
        if (ddlType && ddlType.toUpperCase() !== "TEXT") {
          return coerceForTypedAppend(r?.[c], lakeTypeFromSqlDdl(ddlType));
        }
        return coerceForStorage(r?.[c]);
      }));
    }
    // A date column this batch introduced has its order recorded now, while
    // the slash dates are still in hand — the rows about to land are ISO.
    persistDateOrders(db, safeName, merged.filter((c) => newCols.includes(c.name)));
    bumpMeta(db, safeName, opts.rows.length);
  });
  tx();
  return { added: opts.rows.length, newColumns: newCols };
}

/**
 * Move a fully written staging table into a standard dataset's table
 * (lib/lake/standardDatasets.ts) in ONE transaction: create the target if
 * this is its first import, add any standard column it doesn't have yet,
 * delete what the import replaces, insert the staged rows, drop the
 * staging table. A reader never sees the period half-replaced, and an
 * import that fails before this point leaves the target untouched.
 *
 * What gets replaced, per partition value (branch) found in the staging
 * rows — never row-by-row matching, since one receipt can genuinely hold
 * the same item on two identical lines:
 *   range: every target row from that branch's earliest to latest staged date
 *   exact: every target row on a date the staged rows have for that branch
 *
 * SQLite engine only — the import route refuses a DuckDB tenant before any
 * of this runs (see standardImportProblem in lib/lake/standardImport.ts).
 * Runs on a worker thread (lakeWorker.ts): a merge moves every row of the
 * file, and the event loop stays free while it does.
 */
export async function mergeStagedIntoTable(opts: {
  tenantId: string;
  stagingName: string;
  targetName: string;
  columns: LakeColumn[];
  replace: { kind: "range" | "exact"; dateField: string; partitionField: string };
  sourceConfig: Record<string, unknown>;
}): Promise<{ inserted: number; replaced: number; total: number; periods: Array<{ partition: string; from: string; to: string }> }> {
  const db = openLake(opts.tenantId);
  const staging = toSafeTableName(opts.stagingName);
  const target = toSafeTableName(opts.targetName);
  const part = qIdent(opts.replace.partitionField);
  const date = qIdent(opts.replace.dateField);
  const typed = typedColumnsEnabled();
  const cols = opts.columns.map((c) => qIdent(c.name)).join(", ");
  // Standard columns added to the dataset since the table's first import.
  const have = new Set(allColumnNames(db, target));
  const missing = have.size > 0 ? opts.columns.filter((c) => !have.has(c.name)) : [];

  const statements: LakeStatement[] = [
    { sql: `CREATE TABLE IF NOT EXISTS "${target}" (${opts.columns.map((c) => `${qIdent(c.name)} ${typed ? sqlTypeForLakeColumn(c.type) : "TEXT"}`).join(", ")})` },
    ...missing.map((c) => ({ sql: `ALTER TABLE "${target}" ADD COLUMN ${qIdent(c.name)} TEXT` })),
    // The replace below, and every per-branch, per-date figure worked out
    // from this table (retailMetrics.ts), look rows up by branch and date.
    { sql: `CREATE INDEX IF NOT EXISTS "${target}__by_partition_date" ON "${target}" (${part}, ${date})` },
  ];
  // push() returns the new length: each result's position in the output.
  const periodsAt = statements.push({
    sql: `SELECT ${part} AS partition, MIN(${date}) AS "from", MAX(${date}) AS "to" FROM "${staging}" GROUP BY ${part} ORDER BY ${part}`,
    mode: "all",
  }) - 1;
  const replacedAt = statements.push(opts.replace.kind === "range"
    ? { sql: `DELETE FROM "${target}" WHERE rowid IN (
          SELECT t.rowid FROM (SELECT ${part} AS p, MIN(${date}) AS f, MAX(${date}) AS l FROM "${staging}" GROUP BY ${part}) r
          JOIN "${target}" t ON t.${part} = r.p AND t.${date} BETWEEN r.f AND r.l)` }
    : { sql: `DELETE FROM "${target}" WHERE (${part}, ${date}) IN (SELECT DISTINCT ${part}, ${date} FROM "${staging}")` }) - 1;
  const insertedAt = statements.push({ sql: `INSERT INTO "${target}" (${cols}) SELECT ${cols} FROM "${staging}"` }) - 1;
  statements.push(
    { sql: `DROP TABLE "${staging}"` },
    { sql: `DELETE FROM __lake_meta WHERE table_name = ?`, params: [staging] },
    { sql: UPSERT_META_SQL(`(SELECT COUNT(*) FROM "${target}")`), params: [target, "upload", JSON.stringify(opts.sourceConfig)] },
  );
  const totalAt = statements.push({ sql: `SELECT COUNT(*) AS n FROM "${target}"`, mode: "get" }) - 1;

  const out = await runLakeTransaction(opts.tenantId, statements);
  return {
    periods: out[periodsAt] as Array<{ partition: string; from: string; to: string }>,
    replaced: out[replacedAt] as number,
    inserted: out[insertedAt] as number,
    total: (out[totalAt] as { n: number }).n,
  };
}

/** Add, empty, any of `columns` the table doesn't have yet. */
function addMissingColumns(db: ReturnType<typeof openLake>, table: string, columns: Array<{ name: string }>): number {
  const have = new Set(allColumnNames(db, table));
  const missing = columns.filter((c) => !have.has(c.name));
  for (const c of missing) db.prepare(`ALTER TABLE "${table}" ADD COLUMN ${qIdent(c.name)} TEXT`).run();
  return missing.length;
}

/**
 * Bring an existing standard table up to its dataset's current columns — a
 * table imported before a column was added to the dataset gets it, empty,
 * so queries written against the dataset read it as "not given" rather
 * than failing. The next import into it does the same (mergeStagedIntoTable).
 * SQLite engine only.
 */
export function ensureTableColumns(tenantId: string, tableName: string, columns: Array<{ name: string }>): number {
  const db = openLake(tenantId);
  return addMissingColumns(db, toSafeTableName(tableName), columns);
}

/**
 * Rebuild a table from a SELECT over the tenant's lake, swapped in whole:
 * the new rows are built under a temporary name and renamed over the old
 * table in one transaction, so a reader sees the previous version or the
 * new one, never a half-built or missing table. For figures that are
 * always worked out from other tables (lib/lake/retailMetrics.ts) — the
 * columns keep the types the SELECT gives them (REAL for sums, INTEGER
 * for counts), which every lake reader already handles.
 *
 * `setup` runs first in the same transaction — temporary helper tables a
 * query needs (and drops afterwards). SQLite engine only.
 */
export async function replaceTableFromSelect(opts: {
  tenantId: string;
  tableName: string;
  selectSql: string;
  params?: unknown[];
  setup?: string[];
  teardown?: string[];
  sourceConfig: Record<string, unknown>;
}): Promise<{ rowCount: number; columns: Array<{ name: string; ddlType: string }> }> {
  const target = toSafeTableName(opts.tableName);
  const building = toSafeTableName(`${opts.tableName}__building`);
  // On a worker thread (lakeWorker.ts): a figure over a million-row stock
  // file writes a million rows.
  const statements: LakeStatement[] = [
    ...(opts.setup ?? []).map((sql) => ({ sql })),
    { sql: `DROP TABLE IF EXISTS "${building}"` },
    { sql: `CREATE TABLE "${building}" AS ${opts.selectSql}`, params: opts.params },
    { sql: `DROP TABLE IF EXISTS "${target}"` },
    { sql: `ALTER TABLE "${building}" RENAME TO "${target}"` },
    ...(opts.teardown ?? []).map((sql) => ({ sql })),
    { sql: UPSERT_META_SQL(`(SELECT COUNT(*) FROM "${target}")`), params: [target, "manual", JSON.stringify(opts.sourceConfig)] },
    { sql: `SELECT COUNT(*) AS n FROM "${target}"`, mode: "get" },
    { sql: `PRAGMA table_info("${target}")`, mode: "all" },
  ];
  // The rebuild replaces the table and its meta config, formulas included — read them first, put them back after.
  const priorFormulas = readFormulas(openLake(opts.tenantId), target);
  const out = await runLakeTransaction(opts.tenantId, statements);
  if (Object.keys(priorFormulas).length > 0) {
    const db = openLake(opts.tenantId);
    db.transaction(() => {
      const { kept } = reapplyFormulas(db, target, priorFormulas, schemaForTable(db, target));
      writeFormulas(db, target, kept);
    })();
  }
  const columns = (out[out.length - 1] as Array<{ name: string; type: string }>).map((c) => ({ name: c.name, ddlType: c.type }));
  return { rowCount: (out[out.length - 2] as { n: number }).n, columns };
}

/** Does the tenant's (SQLite) lake have this table? */
export function lakeTableExists(tenantId: string, tableName: string): boolean {
  const db = openLake(tenantId);
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(toSafeTableName(tableName));
}

/**
 * Upsert rows by a primary-key column. Idempotent: existing rows whose
 * keyColumn matches an incoming row get fully replaced; new rows get
 * inserted. Used by the ETL sync connectors (Postgres / Salesforce /
 * Stripe) where the source has a stable PK and we want to merge updates
 * from incremental pulls.
 *
 * The table is created on first call (lazy create with inferred schema)
 * AND the keyColumn is promoted to a UNIQUE constraint so SQLite's
 * `INSERT … ON CONFLICT(keyCol) DO UPDATE` can drive the upsert in one
 * statement per row inside a single transaction.
 *
 * Schema drift: any column that appears in a row but not in the table
 * gets added via ALTER TABLE ADD COLUMN (matching appendRows). Dropped
 * upstream columns stay in the lake — readers see NULL. We never drop
 * a lake column based on a sync, because the user might be reading it
 * from existing reports.
 */
export async function upsertLakeRowsByKey(opts: {
  tenantId: string;
  tableName: string;
  keyColumn: string;
  rows: Array<Record<string, unknown>>;
  /** Optional sourceKind for the meta row on first create. Defaults to "manual". */
  sourceKind?: LakeTableMeta["sourceKind"];
  /** Optional sourceConfig blob for the meta row on first create. */
  sourceConfig?: Record<string, unknown>;
}): Promise<{ upserted: number; newColumns: string[] }> {
  if (opts.rows.length === 0) return { upserted: 0, newColumns: [] };
  if (!opts.keyColumn) throw new Error("upsertLakeRowsByKey: keyColumn is required");

  // A tenant on a paid lake engine (DuckDB) upserts there instead of the
  // default per-tenant SQLite file — see
  // ee.lake.upsertLakeRowsByKeyIfPaidEngine's doc comment.
  const { tenantId, ...rest } = opts;
  const paid = await ee.lake?.upsertLakeRowsByKeyIfPaidEngine(tenantId, rest);
  if (paid != null) return paid;

  const db = openLake(opts.tenantId);
  const safeName = toSafeTableName(opts.tableName);
  const keyCol = opts.keyColumn;

  // Schema discovery from the rows we're inserting.
  const incomingCols = new Set<string>();
  for (const r of opts.rows) for (const k of Object.keys(r ?? {})) incomingCols.add(k);
  if (!incomingCols.has(keyCol)) {
    throw new Error(`upsertLakeRowsByKey: keyColumn "${keyCol}" not present in incoming rows`);
  }

  const existingColRows = db.prepare(`PRAGMA table_info("${safeName}")`).all() as Array<{ name: string; type: string }>;
  let existingCols = existingColRows.map((c) => c.name);
  const tableExists = existingCols.length > 0 && !(existingCols.length === 1 && existingCols[0] === "_empty");
  // E1b Phase C (E1B_TYPED_COLUMNS_SCOPING_PLAN.md) — see appendRows'
  // identical comment for the tableExists case. This function's own
  // first-create path (below, !tableExists) now ALSO emits typed DDL when
  // typedColumnsEnabled() — the same brand-new-table-only rule
  // createOrReplaceTable already follows — so `let`, not `const`: the
  // !tableExists branch below repopulates this map from the columns it
  // just created, since the PRAGMA read above necessarily predates them.
  let existingColDdlTypes = new Map(existingColRows.map((c) => [c.name, c.type]));

  const tx = db.transaction(() => {
    if (!tableExists) {
      // First write — create the table with keyColumn UNIQUE. E1b Phase B
      // (E1B_TYPED_COLUMNS_SCOPING_PLAN.md): typed DDL when
      // typedColumnsEnabled(), same brand-new-table-only rule
      // createOrReplaceTable already follows — this is a genuinely new
      // physical table (DROP+CREATE below), so nothing existing is ever
      // touched. No column-type-override params here (unlike
      // createOrReplaceTable) because this function has no caller that
      // passes any — sync connectors always let inference decide.
      const typed = typedColumnsEnabled();
      const inferred = typed ? resolveColumnsForCreate(opts.rows, {}) : [];
      const inferredRows = typed ? cleanRowsForColumns(opts.rows, inferred) : [];
      // Typed only where every value converts without loss (storageTypeFor), as createOrReplaceTable.
      const inferredTypes = typed
        ? new Map(inferred.map((c) => [c.name, storageTypeFor(c, inferredRows)]))
        : null;
      const cols = Array.from(incomingCols);
      const colDefs = cols.map((c) => {
        const ddlType = typed ? sqlTypeForLakeColumn(inferredTypes!.get(c) ?? "text") : "TEXT";
        return c === keyCol ? `${qIdent(c)} ${ddlType} UNIQUE` : `${qIdent(c)} ${ddlType}`;
      }).join(", ");
      db.prepare(`DROP TABLE IF EXISTS "${safeName}"`).run();
      db.prepare(`CREATE TABLE "${safeName}" (${colDefs})`).run();
      existingCols = cols;
      // The PRAGMA read that built existingColDdlTypes ran before this
      // table existed — repopulate it now so the write loop below
      // (shared with the tableExists branch) coerces this call's own
      // first batch of rows correctly instead of falling back to legacy
      // TEXT coercion against a table it just created typed.
      if (typed) {
        existingColDdlTypes = new Map(cols.map((c) => [c, sqlTypeForLakeColumn(inferredTypes!.get(c) ?? "text")]));
      }
      // Ensure a __lake_meta row exists so /tables surfaces this table.
      upsertMeta(db, safeName, opts.sourceKind ?? "manual", opts.sourceConfig, 0);
    } else if (!existingCols.includes(keyCol)) {
      // Pre-existing table that's missing the keyColumn — can't upsert
      // by a column the table doesn't have. Bail loudly so the caller
      // can either drop the table or pick a different keyColumn.
      throw new Error(`upsertLakeRowsByKey: existing table "${safeName}" has no "${keyCol}" column`);
    } else {
      // A pre-existing table reached this function some other way (an
      // upload via createOrReplaceTable, or appendRows' create-on-first-
      // write path) never got keyCol declared UNIQUE — only THIS
      // function's own !tableExists branch above does that. Without it,
      // the ON CONFLICT(keyCol) below fails outright. See
      // ensureUpsertKeyIndex's own doc comment.
      ensureUpsertKeyIndex(db, safeName, keyCol);
    }

    // ALTER for any new columns. SQLite can't add UNIQUE via ALTER, but
    // the keyColumn doesn't need it here — it's either been UNIQUE since
    // first create (above) or just got one retrofitted by
    // ensureUpsertKeyIndex.
    // A formula column's name in the incoming rows isn't a new column — it works itself out (see appendRows).
    const formulaCols = generatedColumnNames(db, safeName);
    const newCols = Array.from(incomingCols).filter((c) => !existingCols.includes(c) && c !== "_empty" && !formulaCols.has(c));
    for (const c of newCols) {
      db.prepare(`ALTER TABLE "${safeName}" ADD COLUMN ${qIdent(c)} TEXT`).run();
    }
    const allCols = [
      ...existingCols.filter((c) => c !== "_empty"),
      ...newCols,
    ];
    const placeholders = allCols.map(() => "?").join(", ");
    const updateSetters = allCols
      .filter((c) => c !== keyCol)
      .map((c) => `${qIdent(c)} = excluded.${qIdent(c)}`)
      .join(", ");
    // `INSERT ... ON CONFLICT(keyCol) DO UPDATE` is the SQLite upsert
    // idiom. excluded.col is the value from the failed INSERT.
    const stmt = db.prepare(
      `INSERT INTO "${safeName}" (${allCols.map((c) => qIdent(c)).join(", ")}) ` +
        `VALUES (${placeholders}) ` +
        (updateSetters
          ? `ON CONFLICT(${qIdent(keyCol)}) DO UPDATE SET ${updateSetters}`
          : ""),
    );
    // ETL connectors (Postgres/Salesforce/Stripe) mostly hand back native
    // JS types already, so this is a no-op for the common case — but a
    // connector that surfaces a formatted string (occasionally true of
    // REST APIs) gets the same cleaning as every other path, for free.
    // Established-schema-first for the same reason appendRows is: a sync
    // batch is a slice of the table and mustn't retype the whole column
    // to match whatever happened to change this run.
    const establishedUpsert = schemaForTable(db, safeName);
    const batchUpsert = inferColumns(opts.rows);
    const cleanedRows = cleanRowsForColumns(
      opts.rows,
      preferEstablishedColumns(establishedUpsert, batchUpsert),
    );
    for (const r of cleanedRows) {
      stmt.run(...allCols.map((c) => {
        // A column just ALTER'd in above isn't in the map — always TEXT,
        // always legacy coercion. A column from this call's own
        // !tableExists create IS in the map (repopulated above), correctly
        // typed or TEXT depending on typedColumnsEnabled() at the time.
        const ddlType = existingColDdlTypes.get(c);
        if (ddlType && ddlType.toUpperCase() !== "TEXT") {
          return coerceForTypedAppend(r?.[c], lakeTypeFromSqlDdl(ddlType));
        }
        return coerceForStorage(r?.[c]);
      }));
    }
    // bumpMeta is for monotonic rowCount on insert-only paths; we
    // re-derive rowCount via SELECT to keep the meta honest after upsert.
    const total = db.prepare(`SELECT COUNT(*) AS n FROM "${safeName}"`).get() as { n: number };
    db.prepare(
      `UPDATE __lake_meta SET row_count = ?, updated_at = ? WHERE table_name = ?`,
    ).run(total.n, new Date().toISOString(), safeName);

    // Stash newCols on a closure-visible binding so we can return it
    // outside the transaction (better-sqlite3 transactions don't return
    // values directly into the outer scope unless the wrapper does so).
    (tx as any).__newColumns = newCols;
  });
  tx();

  return { upserted: opts.rows.length, newColumns: ((tx as any).__newColumns as string[]) ?? [] };
}

export async function dropTable(tenantId: string, tableName: string): Promise<void> {
  // A tenant on a paid lake engine (DuckDB) drops the table there instead
  // of the default per-tenant SQLite file — see
  // ee.lake.dropTableIfPaidEngine's doc comment.
  const handled = await ee.lake?.dropTableIfPaidEngine(tenantId, tableName);
  if (handled) return;

  const db = openLake(tenantId);
  const safeName = toSafeTableName(tableName);
  const tx = db.transaction(() => {
    db.prepare(`DROP TABLE IF EXISTS "${safeName}"`).run();
    db.prepare(`DELETE FROM __lake_meta WHERE table_name = ?`).run(safeName);
  });
  tx();
}

export function listTables(tenantId: string): LakeTableMeta[] {
  const db = openLake(tenantId);
  const rows = db.prepare(`
    SELECT table_name, source_kind, source_config_json, created_at, updated_at, row_count
    FROM __lake_meta ORDER BY updated_at DESC
  `).all() as any[];
  return rows.map((r) => ({
    name: r.table_name,
    columns: schemaForTable(db, r.table_name),
    rowCount: r.row_count,
    sourceKind: r.source_kind,
    sourceConfig: safeJson(r.source_config_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/**
 * A tenant on a paid lake engine (DuckDB) reads meta there instead of the
 * default per-tenant SQLite file — see ee.lake.getTableIfPaidEngine's doc
 * comment. `undefined` (not `null`) means "this tenant is on the default
 * engine", so we fall through to the SQLite path below, unchanged from
 * before this function became async.
 */
export async function getTable(tenantId: string, tableName: string): Promise<LakeTableMeta | null> {
  const paid = await ee.lake?.getTableIfPaidEngine(tenantId, tableName);
  if (paid !== undefined) return paid;

  const db = openLake(tenantId);
  const safeName = toSafeTableName(tableName);
  const row = db.prepare(`
    SELECT table_name, source_kind, source_config_json, created_at, updated_at, row_count
    FROM __lake_meta WHERE table_name = ?
  `).get(safeName) as any;
  if (!row) return null;
  return {
    name: row.table_name,
    columns: schemaForTable(db, row.table_name),
    rowCount: row.row_count,
    sourceKind: row.source_kind,
    // DATE_ORDERS_KEY is bookkeeping for schemaForTable, not part of the
    // source config any caller asked for — keep it out of the public shape.
    sourceConfig: publicSourceConfig(safeJson(row.source_config_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Run a read-only query on the tenant's lake, through a paid engine (DuckDB)
 * when the tenant is on one — see ee.lake.readLakeIfPaidEngine's doc comment
 * (it refuses file readers posing as tables). `sql` may give a statement per
 * engine, for SQL that differs between them (a formula compiles differently
 * for each). Only ever for SQL built from validated identifiers; values are
 * bound, `?` placeholders in order.
 *
 * `offMainThread` sends a SQLite read to lakeWorker's reader processes, with
 * a time limit and a row cap, as a report's query goes: better-sqlite3 runs
 * on the event loop, so a whole-table scan anyone can start (a sort or a
 * find in the spreadsheet view) otherwise holds every request — health
 * checks included — until it ends (audit 2026-09-30, P3/S5).
 */
export async function queryLake(
  tenantId: string,
  sql: string | { sqlite: string; duckdb: string },
  values: unknown[] = [],
  opts: { offMainThread?: { timeoutMs: number; timeoutMessage: string; cap: number; capMessage: string } } = {},
): Promise<Array<Record<string, unknown>>> {
  const paid = await ee.lake?.readLakeIfPaidEngine(tenantId, typeof sql === "string" ? sql : sql.duckdb, values);
  if (paid != null) return paid;
  const sqliteSql = typeof sql === "string" ? sql : sql.sqlite;
  if (opts.offMainThread) return runLakeRead({ tenantId, sql: sqliteSql, params: values, ...opts.offMainThread });
  return openLake(tenantId).prepare(sqliteSql).all(...values) as Array<Record<string, unknown>>;
}

/**
 * First N rows for the preview pane. Defaults to 50 — comfortable cap
 * for the UI to render in a normal table layout. Optional offset supports
 * paging from the v1 /lake/tables/[name]/rows endpoint.
 *
 * A tenant on a paid lake engine reads there instead — see
 * ee.lake.previewRowsIfPaidEngine's doc comment.
 */
export async function previewRows(
  tenantId: string,
  tableName: string,
  limit = 50,
  offset = 0,
): Promise<any[]> {
  const paid = await ee.lake?.previewRowsIfPaidEngine(tenantId, tableName, limit, offset);
  if (paid !== undefined) return paid;

  const db = openLake(tenantId);
  const safeName = toSafeTableName(tableName);
  const cappedLimit = Math.min(limit, 500);
  const cappedOffset = Math.max(0, offset | 0);
  return db
    .prepare(`SELECT * FROM "${safeName}" LIMIT ? OFFSET ?`)
    .all(cappedLimit, cappedOffset) as any[];
}

/**
 * Count rows for accurate quota + UI display. A tenant on a paid lake
 * engine reads there instead — see ee.lake.rowCountIfPaidEngine's doc
 * comment.
 */
export async function rowCount(tenantId: string, tableName: string): Promise<number> {
  const paid = await ee.lake?.rowCountIfPaidEngine(tenantId, tableName);
  if (paid !== undefined) return paid;

  const db = openLake(tenantId);
  const safeName = toSafeTableName(tableName);
  try {
    const r = db.prepare(`SELECT COUNT(*) as n FROM "${safeName}"`).get() as { n: number };
    return r.n;
  } catch { return 0; }
}

/**
 * Distinct values a real (already-materialised) column actually holds —
 * the FK-resolution counterpart to synthetic.ts's fkKeyValues() for a
 * parent table this build did NOT generate.
 *
 * Master Builder's FK seeding threads real key values forward for a
 * parent table generated in the SAME build (synthetic.ts's fkKeyValues +
 * appliers/table.ts's siblingKeys), but a plan that references an
 * EXISTING tenant table via source:"existing" skips generation for it
 * entirely — there are no in-memory rows to read keys from. Without this,
 * a child table's `fk:<existing table>` hint falls back to the old
 * count-only makeId() reconstruction, which only produces a real match
 * when the parent happens to be keyed on a `*_id` column; a parent keyed
 * on a code (`store_code`, `S-101`-style — every vertical archetype and
 * most hand-authored tables) gets a dangling FK with no matching parent
 * row, confirmed live: a custom plan's "member_sales_monthly.store_code"
 * held "store_0010" against a real retail_stores table keyed "S-101".
 *
 * Queries the actual table rather than trusting the plan's restated
 * column list, so it's correct even when the plan's own re-listing of an
 * existing table's columns drifted from reality.
 *
 * A tenant on a paid lake engine reads there instead — see
 * ee.lake.distinctColumnValuesIfPaidEngine's doc comment.
 */
export async function distinctColumnValues(
  tenantId: string,
  tableName: string,
  columnName: string,
  limit = 500,
): Promise<string[]> {
  const paid = await ee.lake?.distinctColumnValuesIfPaidEngine(tenantId, tableName, columnName, limit);
  if (paid !== undefined) return paid;

  const db = openLake(tenantId);
  const safeName = toSafeTableName(tableName);
  try {
    const rows = db
      .prepare(`SELECT DISTINCT ${qIdent(columnName)} AS v FROM "${safeName}" WHERE ${qIdent(columnName)} IS NOT NULL AND ${qIdent(columnName)} <> '' LIMIT ?`)
      .all(Math.min(Math.max(limit, 1), 2000)) as Array<{ v: unknown }>;
    return rows.map((r) => String(r.v));
  } catch {
    // Column doesn't exist, table doesn't exist, or a locked-DB blip —
    // the caller's own fallback (count-based reconstruction, then NULL)
    // is the right degradation, not a thrown error mid-build.
    return [];
  }
}

// ---------------------------------------------------------------------------
// Schema evolution — Phase 2
// ---------------------------------------------------------------------------

/**
 * Add a new column. SQLite ALTER TABLE ADD COLUMN is the only safe schema
 * change in Phase 2 — rename + drop need the create-new-table-and-copy
 * dance which is more invasive. Default value is optional (NULL otherwise);
 * applies to both existing rows AND future inserts.
 */
export async function addColumn(opts: {
  tenantId: string;
  tableName: string;
  columnName: string;
  defaultValue?: string;
  /** What the column holds. Stored as text like every lake column; the default is cleaned to this type the way an import's values are. */
  type?: Exclude<LakeColumn["type"], "unknown">;
}): Promise<void> {
  // SQLite identifier sanitisation — letters/digits/underscores only,
  // first char a letter. Rejects bobby-tables shenanigans cleanly.
  assertNewColumnName(opts.columnName);
  const defaultValue = cleanDefault(opts.defaultValue, opts.type);
  // A tenant on a paid lake engine (DuckDB) adds it there instead of the
  // default per-tenant SQLite file — routed HERE, like retypeColumn, so no
  // caller can forget to (the schema route did, and Master Builder's
  // migration carried its own copy of this branch).
  if (await ee.lake?.addColumnIfPaidEngine(opts.tenantId, opts.tableName, opts.columnName, defaultValue)) return;

  const db = openLake(opts.tenantId);
  const safeTable = toSafeTableName(opts.tableName);
  // Existence check first so we get a friendlier error than SQLITE_ERROR —
  // against every column, formula columns included.
  const existing = allColumnNames(db, safeTable).map((n) => n.toLowerCase());
  if (existing.includes(opts.columnName.toLowerCase())) {
    throw new Error(`Column "${opts.columnName}" already exists`);
  }
  // ALTER TABLE ADD COLUMN ... DEFAULT 'val' uses a literal default;
  // we always store TEXT so the default goes through as a string.
  const defClause = defaultValue != null
    ? ` DEFAULT '${String(defaultValue).replace(/'/g, "''")}'`
    : "";
  db.prepare(`ALTER TABLE "${safeTable}" ADD COLUMN "${opts.columnName}" TEXT${defClause}`).run();
  bumpMetaUpdatedAt(db, safeTable);
}

/** A new column's default, cleaned to its type like an imported value — "1,299" as a number is 1299, "TRUE" as yes/no is true. */
function cleanDefault(value: string | undefined, type: LakeColumn["type"] | undefined): string | undefined {
  if (value == null || value === "") return undefined;
  if (!type || type === "text" || type === "unknown") return value;
  const cleaned = cleanForType(value, type, {});
  if (cleaned === value && detectCellType(value) !== type) {
    throw new Error(`"${value}" isn't ${type === "number" ? "a number" : type === "date" ? "a date" : "true or false"}`);
  }
  return cleaned;
}

/**
 * Add a formula column, or (replace) change one's formula. The formula is
 * checked against the table's columns (compileFormula — a FormulaError says
 * what's wrong and where); the column is a live generated column the engine
 * works out on read (lib/lake/formulaColumns.ts). Changing a formula that
 * other formula columns read re-adds those after it, and refuses the change
 * if one of them would stop working.
 */
export async function setFormulaColumn(opts: {
  tenantId: string;
  tableName: string;
  columnName: string;
  formula: string;
  replace?: boolean;
}): Promise<{ type: FormulaType; uses: string[] }> {
  assertNewColumnName(opts.columnName);
  const { tenantId, ...rest } = opts;
  const paid = await ee.lake?.setFormulaColumnIfPaidEngine(tenantId, rest);
  if (paid != null) return paid;

  const db = openLake(opts.tenantId);
  const safeTable = toSafeTableName(opts.tableName);
  const names = allColumnNames(db, safeTable);
  if (names.length === 0) throw new Error(`Table "${opts.tableName}" not found`);
  const formulas = readFormulas(db, safeTable);
  if (opts.replace) {
    if (!formulas[opts.columnName]) throw new Error(`"${opts.columnName}" isn't a formula column`);
  } else if (names.some((n) => n.toLowerCase() === opts.columnName.toLowerCase())) {
    throw new Error(`Column "${opts.columnName}" already exists`);
  }
  const schema = schemaForTable(db, safeTable);
  const compiled = compileFormula(opts.formula, { columns: schema, dialect: "sqlite", self: opts.columnName });

  db.transaction(() => {
    const next: StoredFormulas = { ...formulas, [opts.columnName]: { formula: opts.formula, type: compiled.type } };
    // Formula columns read by name; one that reads this column has to come off before it can, and go back after.
    const dependents = opts.replace ? dependentsInOrder(formulas, schema, opts.columnName) : [];
    for (const d of [...dependents].reverse()) db.prepare(`ALTER TABLE "${safeTable}" DROP COLUMN ${qIdent(d)}`).run();
    if (opts.replace) db.prepare(`ALTER TABLE "${safeTable}" DROP COLUMN ${qIdent(opts.columnName)}`).run();
    addGeneratedColumn(db, safeTable, opts.columnName, compiled.sql, compiled.type);
    // Recorded before the dependents are checked, so they're checked against this formula's new type.
    writeFormulas(db, safeTable, next);
    if (dependents.length > 0) {
      const back = Object.fromEntries(dependents.map((d) => [d, formulas[d]!]));
      const { kept, dropped } = reapplyFormulas(db, safeTable, back, schemaForTable(db, safeTable));
      if (dropped.length > 0) {
        throw new Error(`${dropped[0]!.name} uses ${opts.columnName} and would stop working: ${dropped[0]!.reason}`);
      }
      Object.assign(next, kept);
    }
    writeFormulas(db, safeTable, next);
  })();
  return { type: compiled.type, uses: compiled.uses };
}

/**
 * Rename a column. Available in SQLite 3.25+ via ALTER TABLE RENAME COLUMN
 * (which better-sqlite3 ships with). Requires no rebuild.
 */
export async function renameColumn(opts: {
  tenantId: string;
  tableName: string;
  oldName: string;
  newName: string;
}): Promise<void> {
  // See addColumn's note: a paid-engine tenant renames on its own file.
  if (await ee.lake?.renameColumnIfPaidEngine(opts.tenantId, opts.tableName, opts.oldName, opts.newName)) return;

  const db = openLake(opts.tenantId);
  const safeTable = toSafeTableName(opts.tableName);
  assertNewColumnName(opts.newName, "rename");
  const existing = allColumnNames(db, safeTable);
  if (!existing.includes(opts.oldName)) throw new Error(`Column "${opts.oldName}" not found`);
  if (existing.includes(opts.newName)) throw new Error(`Column "${opts.newName}" already exists`);
  db.transaction(() => {
    // SQLite rewrites formula columns' SQL to the new name itself; the formulas as written follow here.
    db.prepare(`ALTER TABLE "${safeTable}" RENAME COLUMN "${opts.oldName}" TO "${opts.newName}"`).run();
    const formulas = readFormulas(db, safeTable);
    if (Object.keys(formulas).length > 0) writeFormulas(db, safeTable, renameInFormulas(formulas, opts.oldName, opts.newName));
    bumpMetaAfterColumnChange(db, safeTable, opts.oldName, opts.newName);
  })();
}

/**
 * Drop a column. SQLite 3.35+ supports ALTER TABLE DROP COLUMN natively
 * (better-sqlite3 ships modern enough). Older SQLite would need the
 * create-new-table-and-copy dance, which we don't need to support yet.
 */
export async function dropColumn(opts: {
  tenantId: string;
  tableName: string;
  columnName: string;
}): Promise<void> {
  // See addColumn's note: a paid-engine tenant drops on its own file.
  if (await ee.lake?.dropColumnIfPaidEngine(opts.tenantId, opts.tableName, opts.columnName)) return;

  const db = openLake(opts.tenantId);
  const safeTable = toSafeTableName(opts.tableName);
  const existing = allColumnNames(db, safeTable);
  if (!existing.includes(opts.columnName)) throw new Error(`Column "${opts.columnName}" not found`);
  const formulas = readFormulas(db, safeTable);
  assertNotReadByFormulas(formulas, schemaForTable(db, safeTable), opts.columnName);
  if (!formulas[opts.columnName] && existing.filter((n) => !formulas[n]).length <= 1) throw new Error("Cannot drop the last column");
  db.transaction(() => {
    db.prepare(`ALTER TABLE "${safeTable}" DROP COLUMN "${opts.columnName}"`).run();
    if (formulas[opts.columnName]) {
      const { [opts.columnName]: _gone, ...rest } = formulas;
      writeFormulas(db, safeTable, rest);
    }
    bumpMetaAfterColumnChange(db, safeTable, opts.columnName, null);
  })();
}

function bumpMetaUpdatedAt(db: DB, tableName: string): void {
  db.prepare(`UPDATE __lake_meta SET updated_at = datetime('now') WHERE table_name = ?`).run(tableName);
}

/** bumpMetaUpdatedAt, plus carrying `oldName`'s stored date order through a
 *  rename (`newName`) or dropping it with the column (`newName === null`) —
 *  see rekeyDateOrder. Runs inside the same transaction as the ALTER so the
 *  two can't disagree. */
function bumpMetaAfterColumnChange(db: DB, tableName: string, oldName: string, newName: string | null): void {
  const row = db.prepare(`SELECT source_config_json FROM __lake_meta WHERE table_name = ?`).get(tableName) as any;
  const cfg = safeJson(row?.source_config_json);
  const next = rekeyDateOrder(cfg, oldName, newName);
  if (next === cfg) { bumpMetaUpdatedAt(db, tableName); return; }
  db.prepare(`UPDATE __lake_meta SET source_config_json = ?, updated_at = datetime('now') WHERE table_name = ?`)
    .run(JSON.stringify(next), tableName);
}

/**
 * Recovery path for a column inference got wrong, or that predates this
 * cleaning behaviour entirely (a table uploaded before this shipped still
 * has raw "$1,299.00"-style text on disk — retyping it now cleans it).
 *
 * Rewrites every existing cell in the column to the target type's cleaned
 * form via the exact same cleanForType() the write paths use, so a
 * retyped column behaves identically to one that was classified correctly
 * on first upload. A cell that can't be cleaned to the new type is left
 * as its original raw text, never nulled — same non-destructive rule as
 * cleanRowsForColumns. Returns counts rather than throwing on a partial
 * mismatch, since "312 cleaned, 4 left as text" is a normal, expected
 * outcome for real-world data, not a failure.
 */
export async function retypeColumn(opts: {
  tenantId: string;
  tableName: string;
  columnName: string;
  type: Exclude<LakeColumn["type"], "unknown">;
  /** Overrides the order detected from the column's own values. */
  dateOrder?: DateOrder;
}): Promise<{ updated: number; unchanged: number }> {
  // E1b Phase D2 (E1B_PHASE_D_SCOPING_PLAN.md) — a tenant on a paid lake
  // engine (DuckDB) retypes there instead of the default per-tenant
  // SQLite file. Added alongside Phase D's own conversion primitive
  // because Phase D's date columns rely on this function (see
  // applyTypedConversion's own doc comment) — without this, a DuckDB
  // tenant couldn't complete the date-column half of a Phase D
  // conversion at all.
  const { tenantId, ...rest } = opts;
  const paid = await ee.lake?.retypeColumnIfPaidEngine(tenantId, rest);
  if (paid != null) return paid;

  const db = openLake(opts.tenantId);
  const safeTable = toSafeTableName(opts.tableName);
  if (readFormulas(db, safeTable)[opts.columnName]) {
    throw new Error(`${opts.columnName} is a formula column — its type is what its formula gives`);
  }
  const existing = (db.prepare(`PRAGMA table_info("${safeTable}")`).all() as any[])
    .map((c: any) => c.name);
  if (!existing.includes(opts.columnName)) throw new Error(`Column "${opts.columnName}" not found`);

  const rows = db
    .prepare(`SELECT rowid AS __rowid, ${qIdent(opts.columnName)} AS v FROM "${safeTable}"`)
    .all() as Array<{ __rowid: number; v: string | null }>;

  // Retyping to date re-reads the raw text, so the same day-first /
  // month-first question applies here as at ingest — decided from every
  // value in the column, not just the sample, since they're all in hand.
  const dateOrder = opts.type === "date"
    ? opts.dateOrder ?? detectDateOrder(rows.map((r) => r.v).filter((v): v is string => typeof v === "string")).order
    : undefined;

  let updated = 0;
  let unchanged = 0;
  const tx = db.transaction(() => {
    const stmt = db.prepare(`UPDATE "${safeTable}" SET ${qIdent(opts.columnName)} = ? WHERE rowid = ?`);
    for (const row of rows) {
      // Null, or already a number in a typed (REAL/INTEGER) column: nothing left to clean — only text cells are.
      if (row.v == null || typeof row.v !== "string") { unchanged++; continue; }
      if (meansNull(row.v, opts.type)) {
        // A leftover "N/A"/"-"/etc from before this feature existed — clean
        // it to a real NULL. Retyping TO text is the one case where these
        // tokens are values rather than gaps, so meansNull spares them
        // there; see its note.
        stmt.run(null, row.__rowid);
        updated++;
        continue;
      }
      const cleaned = cleanForType(row.v, opts.type, { dateOrder });
      if (cleaned !== row.v) { stmt.run(cleaned, row.__rowid); updated++; }
      else { unchanged++; }
    }
    // Same reason as ingest: the values are ISO after this runs, so the
    // order has to be recorded now or it's gone.
    if (dateOrder) {
      persistDateOrders(db, safeTable, [{ name: opts.columnName, type: "date", dateOrder }]);
    }
    bumpMetaUpdatedAt(db, safeTable);
  });
  tx();
  return { updated, unchanged };
}

// ---------------------------------------------------------------------------
// E1b Phase D (E1B_PHASE_D_SCOPING_PLAN.md) — D1: the existing-table
// typed-conversion rebuild primitive, SQLite only. No UI/API surface yet —
// these are plain functions, called directly by tests and (later) by a
// route. See the RFC for the full design rationale; the summary:
//
//   - Only "number" and "boolean" columns ever need a physical rebuild on
//     SQLite. A "date" column's DDL is TEXT either way
//     (sqlTypeForLakeColumn maps date -> TEXT, same as today), so
//     converting one needs no CREATE-TABLE-and-copy at all — retypeColumn
//     above already does the right, non-destructive thing for it.
//   - Option C (the RFC's recommended answer to "what happens to a value
//     that doesn't parse"): preview shows the admin the EXACT cells that
//     would lose information, over a full scan of every row — not the
//     500-row sample inferColumns uses to decide a column's candidate
//     type in the first place. Applying re-derives a fresh preview and
//     only ever touches the columns the caller confirms.
//   - A "lossy" cell for a number column is one coerceForTypedStorage
//     would turn into NULL. A "lossy" cell for a boolean column is
//     different and easy to miss: coerceForTypedStorage's boolean case
//     has no NULL outcome at all — any string that isn't exactly "true"
//     (or "1") silently becomes 0/false. Since detectCellType only ever
//     votes a column "boolean" for the literal tokens "true"/"false"
//     (valueClean.ts's own doc comment), this should be rare in practice,
//     but it's a real, different failure mode from nulling and the
//     preview must name it as such rather than lumping it in with "null".
//   - Concurrency note for whichever future phase builds the UI/API on
//     top of this: applyTypedConversion re-derives its own preview rather
//     than trusting a caller-supplied one, so it never applies a stale
//     confirmation — but if the table's data changes between an admin
//     viewing a preview and clicking confirm, the actual counts can
//     legitimately differ from what they saw. That's a real gap this
//     primitive doesn't close by itself; a route built on top of it needs
//     its own answer (re-preview and re-confirm on drift, a lock, etc.).
// ---------------------------------------------------------------------------

/** Types whose SQLite DDL genuinely differs from TEXT — see the module
 *  comment above for why "date" isn't in this set. */
const PHYSICALLY_CONVERTIBLE_TYPES = new Set<LakeColumn["type"]>(["number", "boolean"]);

/**
 * Clean + coerce one raw cell exactly the way the physical rebuild will,
 * and say whether doing so loses information. Shared by
 * previewTypedConversion and applyTypedConversion so the two can never
 * disagree about which cells are "lossy" — the whole point of showing a
 * preview is that applying honors it exactly.
 */
function classifyTypedConversionCell(
  raw: unknown,
  type: "number" | "boolean",
): { coerced: unknown; lossy: boolean } {
  if (raw == null || raw === "") return { coerced: null, lossy: false };
  if (typeof raw === "string" && isNullToken(raw)) return { coerced: null, lossy: false };
  const rawStr = typeof raw === "string" ? raw : String(raw);
  const cleaned = cleanForType(rawStr, type);
  const coerced = coerceForTypedStorage(cleaned, type);
  const lossy = type === "number"
    ? coerced === null
    : cleaned.trim().toLowerCase() !== "true" && cleaned.trim().toLowerCase() !== "false";
  return { coerced, lossy };
}

/** Up to this many raw examples of a lossy cell are kept per column, for a
 *  future UI to actually show the admin — not meant to be the full list
 *  for a column with thousands of affected rows. */
const CONVERSION_PREVIEW_SAMPLE_LIMIT = 20;

export type TypedConversionColumnPreview = {
  name: string;
  // "date" is here for engine-shared typing only — SQLite's own
  // PHYSICALLY_CONVERTIBLE_TYPES never produces it (see the module
  // comment above); DuckDB's D2 counterpart does, since date genuinely
  // gets a different physical type there (TIMESTAMP vs. VARCHAR).
  proposedType: "number" | "boolean" | "date";
  /** Only meaningful when proposedType is "date" (DuckDB). */
  dateOrder?: DateOrder;
  /** Cells that would lose information under the proposed type — see the
   *  module comment above for what "lossy" means per type. */
  lossyCells: number;
  /** Non-null, non-null-token cells actually examined (the denominator
   *  for lossyCells) — a full-table count, not the 500-row inference sample. */
  consideredCells: number;
  sampleLossyValues: string[];
};

export type TypedConversionPreview = {
  tableName: string;
  totalRows: number;
  eligibleColumns: TypedConversionColumnPreview[];
  skippedColumns: Array<{ name: string; reason: string }>;
};

/**
 * Read-only. Full-scan preview of what converting this table's legacy
 * TEXT columns to physical number/boolean DDL would do, per column:
 * which columns qualify, and exactly which cells would lose information
 * if that column were converted. Never mutates anything — safe to call
 * regardless of typedColumnsEnabled(), so an admin (or a future UI) can
 * see what conversion would look like before anything is turned on.
 */
export async function previewTypedConversion(opts: {
  tenantId: string;
  tableName: string;
}): Promise<TypedConversionPreview> {
  // E1b Phase D2 — a tenant on a paid lake engine (DuckDB) previews there
  // instead of the default per-tenant SQLite file. Checked first, before
  // openLake() below, so a DuckDB tenant never gets an SQLite file
  // touched/created just from calling this.
  const { tenantId, ...rest } = opts;
  const paid = await ee.lake?.previewTypedConversionIfPaidEngine(tenantId, rest);
  if (paid != null) return paid;

  const db = openLake(opts.tenantId);
  const safeName = toSafeTableName(opts.tableName);
  const ddlCols = db.prepare(`PRAGMA table_info("${safeName}")`).all() as Array<{ name: string; type: string }>;
  if (ddlCols.length === 0) throw new Error(`Table "${opts.tableName}" not found`);

  const rows = db.prepare(`SELECT * FROM "${safeName}"`).all() as Array<Record<string, unknown>>;
  const inferredByName = new Map(inferColumns(rows).map((c) => [c.name, c]));

  const eligibleColumns: TypedConversionColumnPreview[] = [];
  const skippedColumns: Array<{ name: string; reason: string }> = [];

  for (const ddlCol of ddlCols) {
    if (ddlCol.name === "_empty") {
      skippedColumns.push({ name: ddlCol.name, reason: "empty-table placeholder column, not real data" });
      continue;
    }
    if (ddlCol.type.toUpperCase() !== "TEXT") {
      skippedColumns.push({ name: ddlCol.name, reason: `already ${ddlCol.type} — not a legacy TEXT column` });
      continue;
    }
    if (rows.length === 0) {
      skippedColumns.push({ name: ddlCol.name, reason: "table has no rows yet — nothing to infer a type from" });
      continue;
    }
    const candidateType = inferredByName.get(ddlCol.name)?.type;
    if (!candidateType || !PHYSICALLY_CONVERTIBLE_TYPES.has(candidateType)) {
      skippedColumns.push({
        name: ddlCol.name,
        reason: candidateType === "date"
          ? "date columns need no physical rebuild on SQLite (TEXT either way) — use retypeColumn instead"
          : `doesn't clear the ${Math.round(TYPE_VOTE_THRESHOLD * 100)}% majority needed to type as a number or boolean`,
      });
      continue;
    }

    let lossyCells = 0;
    let consideredCells = 0;
    const sampleLossyValues: string[] = [];
    for (const r of rows) {
      const raw = r?.[ddlCol.name];
      if (raw == null || raw === "") continue;
      if (typeof raw === "string" && isNullToken(raw)) continue;
      consideredCells++;
      const { lossy } = classifyTypedConversionCell(raw, candidateType as "number" | "boolean");
      if (lossy) {
        lossyCells++;
        if (sampleLossyValues.length < CONVERSION_PREVIEW_SAMPLE_LIMIT) {
          sampleLossyValues.push(typeof raw === "string" ? raw : String(raw));
        }
      }
    }

    eligibleColumns.push({
      name: ddlCol.name,
      proposedType: candidateType as "number" | "boolean",
      lossyCells,
      consideredCells,
      sampleLossyValues,
    });
  }

  return { tableName: safeName, totalRows: rows.length, eligibleColumns, skippedColumns };
}

export type TypedConversionResult = {
  convertedColumns: string[];
  skippedColumns: string[];
  lossyCells: number;
  /** Lossy cells per CONVERTED column — what a caller compares against the
   *  counts its admin was shown and confirmed (see expectedLossy below). */
  lossyByColumn: Record<string, number>;
  /** Final schema of every column in the table, typed and untouched alike
   *  — a future route can persist this straight to LakeTable.schemaJson
   *  the same way retypeColumn's own caller does today, without
   *  re-inferring from scratch. */
  columns: LakeColumn[];
};

/**
 * The check that makes Option C's promise real: what an admin confirmed is
 * exactly what happens. `actual` holds one entry per column being converted
 * (0 included), so a column the caller never confirmed (no entry in
 * `expected`) counts as drift too. Called by both engines, inside their
 * rebuild transaction, before the original table is touched. A no-op when
 * `expected` is absent — callers that never showed anyone a preview
 * (tests, scripts) aren't forced to invent one.
 */
export function assertConfirmedLossy(
  expected: Record<string, number> | undefined,
  actual: Record<string, number>,
): void {
  if (!expected) return;
  for (const [column, count] of Object.entries(actual)) {
    if (expected[column] !== count) throw new TypedConversionDriftError(expected, actual);
  }
}

/**
 * Apply a typed-column conversion. Re-derives its own preview rather than
 * trusting a caller-supplied one (see the module comment above on why),
 * and only ever rebuilds the columns named in `opts.columns` — defaults
 * to every column the fresh preview finds eligible. Gated behind
 * typedColumnsEnabled(): this is real DDL rewriting real existing rows,
 * and should never fire in an environment where no other part of the
 * typed-columns machinery is meant to be active.
 *
 * Mechanics: CREATE a new table with every column's existing DDL except
 * the ones being converted (which get sqlTypeForLakeColumn's typed DDL
 * instead), INSERT every row through the exact same clean+coerce pipeline
 * createOrReplaceTable already uses for a brand-new table, then swap the
 * new table in for the old one. One transaction — a failure partway
 * leaves the original table completely untouched.
 *
 * E1b Phase D3 — where the edition has lake branches (paid), the whole
 * conversion runs inside ee.lake.withTypedConversionGuard, which refuses
 * while any branch is open on the tenant: a later mergeBranch swaps the
 * entire lake file and would silently revert this. Enforced HERE, on the
 * primitive, rather than left to whichever route calls it, so no caller
 * can forget it. Community has no branches and no guard member, so the
 * conversion just runs.
 */
export async function applyTypedConversion(opts: {
  tenantId: string;
  tableName: string;
  columns?: string[];
  /** Per-column lossy-cell counts the admin was shown and confirmed. When
   *  given, the conversion aborts (TypedConversionDriftError, nothing
   *  changed) unless the rebuild would lose exactly these counts. */
  expectedLossy?: Record<string, number>;
}): Promise<TypedConversionResult> {
  if (!typedColumnsEnabled()) {
    throw new Error(
      "applyTypedConversion: CURF_LAKE_TYPED_COLUMNS is not enabled — turn it on before converting an existing table.",
    );
  }
  const run = () => applyTypedConversionUnguarded(opts);
  return ee.lake ? ee.lake.withTypedConversionGuard(opts.tenantId, run) : run();
}

async function applyTypedConversionUnguarded(opts: {
  tenantId: string;
  tableName: string;
  columns?: string[];
  expectedLossy?: Record<string, number>;
}): Promise<TypedConversionResult> {
  // E1b Phase D2 — a tenant on a paid lake engine (DuckDB) converts there
  // instead of the default per-tenant SQLite file. Checked before
  // openLake() below for the same reason previewTypedConversion does.
  const { tenantId, ...rest } = opts;
  const paid = await ee.lake?.applyTypedConversionIfPaidEngine(tenantId, rest);
  if (paid != null) return paid;

  const db = openLake(opts.tenantId);
  const safeName = toSafeTableName(opts.tableName);

  const preview = await previewTypedConversion(opts);
  const requestedNames = new Set(opts.columns ?? preview.eligibleColumns.map((c) => c.name));
  // previewTypedConversion's SQLite path never puts a "date" column into
  // eligibleColumns (PHYSICALLY_CONVERTIBLE_TYPES excludes it — see the
  // module comment above), so proposedType is always "number" | "boolean"
  // here in practice; the field is typed wider only because DuckDB's D2
  // counterpart shares this type and genuinely needs "date".
  const toConvert = preview.eligibleColumns.filter((c) => requestedNames.has(c.name)) as
    Array<TypedConversionColumnPreview & { proposedType: "number" | "boolean" }>;
  const skippedColumns = [...requestedNames].filter((n) => !toConvert.some((c) => c.name === n));

  if (toConvert.length === 0) {
    return { convertedColumns: [], skippedColumns, lossyCells: 0, lossyByColumn: {}, columns: schemaForTable(db, safeName) };
  }

  const ddlCols = db.prepare(`PRAGMA table_info("${safeName}")`).all() as Array<{ name: string; type: string }>;
  const formulas = readFormulas(db, safeName);
  const typeByName = new Map(toConvert.map((c) => [c.name, c.proposedType]));
  const rows = db.prepare(`SELECT * FROM "${safeName}"`).all() as Array<Record<string, unknown>>;
  const tmpName = `${safeName}__phase_d_rebuild`;
  // toSafeTableName's charset (letters/digits/underscores) doesn't forbid
  // a real table literally named "<name>__phase_d_rebuild" — refuse to
  // proceed rather than silently DROP it below on the (rare) chance one
  // exists, instead of just trusting the name is free the way a
  // just-generated random suffix could.
  const tmpNameTaken = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tmpName)) != null;
  if (tmpNameTaken) {
    throw new Error(
      `applyTypedConversion: a table named "${tmpName}" already exists — rename or drop it before converting "${safeName}".`,
    );
  }

  let lossyCells = 0;
  const lossyByColumn: Record<string, number> = Object.fromEntries(toConvert.map((c) => [c.name, 0]));
  const tx = db.transaction(() => {
    const colDefs = ddlCols.map((c) => {
      const newType = typeByName.get(c.name);
      return `${qIdent(c.name)} ${newType ? sqlTypeForLakeColumn(newType) : c.type}`;
    }).join(", ");
    db.prepare(`CREATE TABLE "${tmpName}" (${colDefs})`).run();
    const insert = db.prepare(
      `INSERT INTO "${tmpName}" (${ddlCols.map((c) => qIdent(c.name)).join(", ")}) VALUES (${ddlCols.map(() => "?").join(", ")})`,
    );
    for (const r of rows) {
      const values = ddlCols.map((c) => {
        const raw = r?.[c.name];
        const newType = typeByName.get(c.name);
        if (!newType) return coerceForStorage(raw);
        const { coerced, lossy } = classifyTypedConversionCell(raw, newType);
        if (lossy) { lossyCells++; lossyByColumn[c.name]++; }
        return coerced;
      });
      insert.run(...values);
    }
    // Before the original is dropped: a mismatch throws, the transaction
    // rolls back (tmp table included), and nothing has changed.
    assertConfirmedLossy(opts.expectedLossy, lossyByColumn);
    db.prepare(`DROP TABLE "${safeName}"`).run();
    db.prepare(`ALTER TABLE "${tmpName}" RENAME TO "${safeName}"`).run();
    // The rebuild copied the stored columns only (table_info): put the
    // formula columns back on the converted table. One that would stop
    // working against the new types rolls the whole conversion back.
    if (Object.keys(formulas).length > 0) {
      const { kept, dropped } = reapplyFormulas(db, safeName, formulas, schemaForTable(db, safeName));
      if (dropped.length > 0) {
        throw new Error(`Converting would break the formula column ${dropped[0]!.name}: ${dropped[0]!.reason}. Change or remove it first.`);
      }
      writeFormulas(db, safeName, kept);
    }
    bumpMetaUpdatedAt(db, safeName);
  });
  tx();

  return {
    convertedColumns: toConvert.map((c) => c.name),
    skippedColumns,
    lossyCells,
    lossyByColumn,
    columns: schemaForTable(db, safeName),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Params: table name, source kind, source config JSON — plus `?` for the count when countExpr is "?". */
const UPSERT_META_SQL = (countExpr: string) => `
    INSERT INTO __lake_meta (table_name, source_kind, source_config_json, row_count, updated_at)
    VALUES (?, ?, ?, ${countExpr}, datetime('now'))
    ON CONFLICT(table_name) DO UPDATE SET
      source_kind = excluded.source_kind,
      source_config_json = excluded.source_config_json,
      row_count = excluded.row_count,
      updated_at = datetime('now')
  `;

function upsertMeta(db: DB, tableName: string, kind: string, config: any, count: number): void {
  db.prepare(UPSERT_META_SQL("?")).run(tableName, kind, config ? JSON.stringify(config) : null, count);
}

function bumpMeta(db: DB, tableName: string, addedRows: number): void {
  db.prepare(`
    UPDATE __lake_meta
    SET row_count = row_count + ?, updated_at = datetime('now')
    WHERE table_name = ?
  `).run(addedRows, tableName);
}

/**
 * Deterministic, collision-proof index name for ensureUpsertKeyIndex: two
 * distinct (tableName, keyCol) pairs can never produce the same string,
 * because each part is length-prefixed rather than just concatenated
 * (a plain `${tableName}_${keyCol}` would let table "a_b" col "c" collide
 * with table "a" col "b_c"). SQLite/DuckDB index names share one
 * namespace with every other table in the schema, so this can't just be
 * "idx_<keyCol>" the way a single-table migration might.
 */
export function upsertKeyIndexName(tableName: string, keyCol: string): string {
  return `__lake_upsertkey_${tableName.length}_${tableName}_${keyCol.length}_${keyCol}`;
}

/**
 * Guarantee `keyCol` has a UNIQUE index before `upsertLakeRowsByKey`'s own
 * `INSERT ... ON CONFLICT(keyCol)` runs. This function's OWN first-create
 * path (above) already declares the column UNIQUE inline — but a table
 * that reached upsertLakeRowsByKey any other way (created via
 * createOrReplaceTable/upload, or appendRows' create-on-first-write
 * fallback) has no such guarantee, and SQLite rejects an ON CONFLICT
 * target with no matching constraint outright: "ON CONFLICT clause does
 * not match any PRIMARY KEY or UNIQUE constraint" — a confusing failure
 * for what looks like an ordinary upsert call. CREATE UNIQUE INDEX IF NOT
 * EXISTS is idempotent (a no-op once the index exists, on every call
 * after the first) and, if the column already holds duplicate values,
 * fails immediately and loudly (SQLite: "UNIQUE constraint failed") —
 * exactly the failure this function should have instead of silently
 * upserting into the wrong row, rather than a bug this function should
 * paper over by picking a different key or de-duplicating on its own.
 */
function ensureUpsertKeyIndex(db: DB, tableName: string, keyCol: string): void {
  try {
    db.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${qIdent(upsertKeyIndexName(tableName, keyCol))} ON ${qIdent(tableName)}(${qIdent(keyCol)})`,
    ).run();
  } catch (e) {
    throw new Error(
      `upsertLakeRowsByKey: column "${keyCol}" on table "${tableName}" has duplicate values, so it can't be used as an upsert key (${(e as Error).message})`,
    );
  }
}

/**
 * Reserved key inside `__lake_meta.source_config_json` holding each date
 * column's day/month order.
 *
 * It has to be stored rather than re-derived, because cleaning is what
 * destroys the evidence: after ingest the column holds ISO dates, and no
 * amount of reading "2024-04-13" back tells you the file said 13/04. A
 * later append of "03/04/2024" would then be read month-first against a
 * table that was built day-first, and land eleven months out.
 */
export const DATE_ORDERS_KEY = "__dateOrders";

/** Exported so the DuckDB write path (lib/lake/engine/duckdbWrite.ts)
 *  stashes date orders into a table's meta config the same way. */
export function withDateOrders(config: any, columns: LakeColumn[]): any {
  const orders: Record<string, DateOrder> = {};
  for (const c of columns) if (c.type === "date" && c.dateOrder) orders[c.name] = c.dateOrder;
  if (Object.keys(orders).length === 0) return config;
  return { ...(config ?? {}), [DATE_ORDERS_KEY]: orders };
}

/** Pure counterpart to withDateOrders: pull the stashed day/month orders
 *  back out of a table's meta config. Exported for the same reason. */
export function extractDateOrders(config: Record<string, unknown> | null | undefined): Record<string, DateOrder> {
  const orders = config?.[DATE_ORDERS_KEY];
  return orders && typeof orders === "object" ? orders as Record<string, DateOrder> : {};
}

/**
 * Follow a column through a rename (`newName`) or a drop (`newName === null`)
 * in the stored date orders. They're keyed by column NAME, so a rename that
 * doesn't move the entry strands it: the renamed column then has no stored
 * order, and its next append is read with whatever order that batch happens
 * to look like — the eleven-months-out failure DATE_ORDERS_KEY's own comment
 * describes. Pure; returns `config` itself (same reference) when the column
 * has no stored order, so a caller can tell nothing changed. Exported for the
 * DuckDB write path, same as withDateOrders.
 */
export function rekeyDateOrder(
  config: Record<string, unknown> | null | undefined,
  oldName: string,
  newName: string | null,
): Record<string, unknown> | null | undefined {
  const orders = extractDateOrders(config);
  if (!Object.prototype.hasOwnProperty.call(orders, oldName)) return config;
  const { [oldName]: order, ...rest } = orders;
  const next = newName === null ? rest : { ...rest, [newName]: order };
  return Object.keys(next).length === 0
    ? publicSourceConfig(config ?? undefined) ?? {}
    : { ...(config ?? {}), [DATE_ORDERS_KEY]: next };
}

/**
 * For each batch-inferred column, prefer the established (already-stored)
 * column when one exists — a batch is a slice of the table and shouldn't
 * retype or re-decide the date order for a column the table already has.
 * Shared by appendRows and upsertLakeRowsByKey (both engines).
 */
export function preferEstablishedColumns(established: LakeColumn[], batch: LakeColumn[]): LakeColumn[] {
  return batch.map((bc) => established.find((ec) => ec.name === bc.name) ?? bc);
}

/** Merge these columns' date orders into the table's stored meta. */
function persistDateOrders(db: DB, tableName: string, columns: LakeColumn[]): void {
  const add: Record<string, DateOrder> = {};
  for (const c of columns) if (c.type === "date" && c.dateOrder) add[c.name] = c.dateOrder;
  if (Object.keys(add).length === 0) return;
  const row = db.prepare(`SELECT source_config_json FROM __lake_meta WHERE table_name = ?`).get(tableName) as any;
  const cfg = safeJson(row?.source_config_json) ?? {};
  const next = { ...cfg, [DATE_ORDERS_KEY]: { ...readDateOrders(db, tableName), ...add } };
  db.prepare(`UPDATE __lake_meta SET source_config_json = ? WHERE table_name = ?`)
    .run(JSON.stringify(next), tableName);
}

/**
 * A table's meta config without the bookkeeping kept in it — stored date
 * orders and formulas, which the columns already carry. Exported for reuse
 * by the DuckDB read path (lib/lake/engine/duckdbRead.ts).
 */
export function publicSourceConfig(config: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!config || (!(DATE_ORDERS_KEY in config) && !(FORMULAS_KEY in config))) return config;
  const { [DATE_ORDERS_KEY]: _dates, [FORMULAS_KEY]: _formulas, ...rest } = config;
  return rest;
}

function readDateOrders(db: DB, tableName: string): Record<string, DateOrder> {
  const row = db.prepare(`SELECT source_config_json FROM __lake_meta WHERE table_name = ?`).get(tableName) as any;
  return extractDateOrders(safeJson(row?.source_config_json));
}

function schemaForTable(db: DB, tableName: string): LakeColumn[] {
  // table_xinfo, not table_info: formula columns (generated) are columns too.
  const xinfo = db.prepare(`PRAGMA table_xinfo("${tableName}")`).all() as Array<{ name: string; type: string; hidden: number }>;
  const formulas = readFormulas(db, tableName);
  const cols = xinfo.filter((c) => c.hidden === 0);
  const formulaCols = new Map<string, LakeColumn>(
    xinfo.filter((c) => c.hidden === 2 || c.hidden === 3).map((c) => {
      const f = formulas[c.name];
      return [c.name, f ? { name: c.name, type: f.type, formula: f.formula } : { name: c.name, type: lakeTypeFromSqlDdl(c.type) }];
    }),
  );

  // E1b Phase C (E1B_TYPED_COLUMNS_SCOPING_PLAN.md) — a column whose DDL
  // is REAL or INTEGER (Phase B's typed path) has an unambiguous logical
  // type straight from the schema; it doesn't need re-inferring from
  // sample values the way a TEXT column does. This isn't just an
  // optimization: re-inferring from VALUES alone is actively wrong for a
  // boolean column stored as INTEGER — a sampled 0/1 is indistinguishable
  // from a genuine small number by value (typeOf() reads a JS number as
  // "number" full stop), so a boolean column would silently relabel
  // itself "number" the moment this function looked at real data. Only
  // TEXT columns (the only ones that were ever ambiguous) fall through to
  // sample-based inference below, exactly as every column did before
  // Phase B existed.
  const typed: LakeColumn[] = [];
  const textColNames: string[] = [];
  for (const c of cols) {
    const ddlType = lakeTypeFromSqlDdl(c.type);
    if (ddlType === "number" || ddlType === "boolean") typed.push({ name: c.name, type: ddlType });
    else textColNames.push(c.name);
  }

  const byName = new Map(typed.map((c) => [c.name, c]));
  const sample = cols.length > 0 ? db.prepare(`SELECT * FROM "${tableName}" LIMIT 100`).all() as any[] : [];
  // A typed column's type needs no sample, but its example value does: the table page and the AI's schema show it.
  for (const c of typed) {
    const v = sample.find((r) => r[c.name] != null)?.[c.name];
    if (v != null) c.sample = v;
  }
  if (textColNames.length > 0) {
    if (sample.length === 0) {
      for (const name of textColNames) byName.set(name, { name, type: "text" });
    } else {
      const textOnlySample = sample.map((r) => Object.fromEntries(textColNames.map((n) => [n, r[n]])));
      const inferred = inferColumns(textOnlySample);
      // Restore each date column's stored order over the one just
      // re-inferred from ISO values, which can only ever be the fallback.
      const orders = readDateOrders(db, tableName);
      for (const c of inferred) {
        if (c.type === "date" && orders[c.name]) c.dateOrder = orders[c.name];
        byName.set(c.name, c);
      }
    }
  }
  // Preserve the table's real column order (PRAGMA's), not
  // typed-then-inferred concatenation order.
  return xinfo.filter((c) => c.hidden !== 1).map((c) => formulaCols.get(c.name) ?? byName.get(c.name)!);
}

function safeJson(s: string | null | undefined): Record<string, unknown> | undefined {
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

/**
 * Convert any incoming JS value to the storage representation. Strings,
 * numbers, booleans go straight through (better-sqlite3 handles those
 * natively). Objects/arrays get JSON-stringified so structured payloads
 * survive a round trip without surprising the runner.
 */
export function coerceForStorage(v: unknown): string | null {
  // Every lake column has TEXT affinity (see createOrReplaceTable). Bind
  // every non-null value as a string so SQLite's affinity coercion doesn't
  // surprise us — historically we returned numbers unchanged here, but
  // better-sqlite3 binds JS Number as REAL, then SQLite renders REAL→TEXT
  // as "1.0" instead of "1". Stringifying explicitly fixes that and also
  // avoids Date→JSON.stringify wrapping ISO timestamps in extra quotes.
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") {
    // Integers render without a trailing ".0", floats keep their decimal.
    return Number.isFinite(v) ? String(v) : null;
  }
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object" && v && "toISOString" in v && typeof (v as any).toISOString === "function") {
    // Defensive: pg's Date objects sometimes arrive as a subclass that
    // doesn't pass instanceof Date across module boundaries.
    try { return (v as any).toISOString(); } catch { /* fall through */ }
  }
  // Arrays / plain objects → JSON. Used for JSON columns in Postgres and
  // for nested structures uploaded from JSON files.
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * E1b typed storage (E1B_TYPED_COLUMNS_SCOPING_PLAN.md). Off by default in
 * code; ON in the cloud deployment (k8s/deployment.yaml) and local dev
 * (.env.example) since 2026-09-30. When on, a brand-new table (create,
 * replace, an upsert's first write — both engines) stores each column typed
 * (REAL/INTEGER on SQLite, DOUBLE/BOOLEAN/TIMESTAMP on DuckDB) so numbers
 * compare and sort as numbers.
 *
 * Nothing is lost on the way in: a column is typed only when every value
 * converts (storageTypeFor — otherwise it stays TEXT with every cell), and
 * an append into a typed column keeps a value that won't convert
 * (coerceForTypedAppend on SQLite; widenForStrays to VARCHAR on DuckDB).
 * Appends and upserts read each column's declared type and bind to it
 * (Phase C). Existing TEXT tables are untouched until an admin converts
 * them (applyTypedConversion — preview, confirm). Turned off, new tables
 * go back to TEXT; tables already typed stay typed and keep working.
 *
 * A function, not a module-level const, so it re-reads the env var on
 * every call — lets tests toggle it per-test without a module reset,
 * matching this codebase's existing CURF_SYNC=on-style env-gated rollout
 * convention (see lib/sync/scheduler.ts's own header comment).
 */
export function typedColumnsEnabled(): boolean {
  return process.env.CURF_LAKE_TYPED_COLUMNS === "true";
}

/**
 * E1b Phase B — coerce a cleaned value into its NATIVE bindable form for
 * a typed column, instead of coerceForStorage's always-a-string
 * contract. Used ONLY by createOrReplaceTable's typed-DDL path (behind
 * typedColumnsEnabled()) — see that function's own doc comment for why
 * every other write path is untouched.
 *
 * A value that doesn't cleanly parse into the column's declared type
 * becomes NULL, not an error and not silently-wrong data — a physically
 * typed column has no "store literally anything" escape hatch the way a
 * TEXT column does. This is a real, deliberate behavior change from
 * today's all-TEXT columns, which preserve unparseable input as raw text
 * via cleanForType's own non-destructive design — scoped to the ≤10% of
 * rows inferColumns' own majority-vote threshold already tolerates being
 * the "wrong" type for a column. Falling back to TEXT for a whole column
 * when even one row doesn't parse, rather than nulling that one row, is
 * a real, valuable refinement — flagged here rather than built into this
 * pass; see E1B_TYPED_COLUMNS_SCOPING_PLAN.md.
 */
/**
 * The type a column of a NEW table is stored as, given the (cleaned) rows
 * going into it: its inferred type when every value converts to that type
 * without loss, otherwise text. Inference calls a column "number" with up to
 * 10% of cells that aren't ("see note", "call back"); stored typed, those cells
 * would become NULL with nobody asked (coerceForTypedStorage) — and a
 * "yes" in a boolean column would become false. Such a column stays TEXT and
 * keeps every cell; the catalog still says "number", and a query reading it
 * CASTs (lib/lake/textNumbers.ts sees to that). Converting it on purpose is
 * the admin's preview-and-confirm (applyTypedConversion). Both engines.
 */
export function storageTypeFor(column: Pick<LakeColumn, "name" | "type">, rows: Array<Record<string, unknown>>): LakeColumn["type"] {
  const t = column.type;
  if (t !== "number" && t !== "boolean" && t !== "date") return t;
  for (const r of rows) {
    const v = r?.[column.name];
    if (v == null || v === "") continue;
    if (!convertsLosslessly(v, t)) return "text";
  }
  return t;
}

export function convertsLosslessly(v: unknown, type: "number" | "boolean" | "date"): boolean {
  switch (type) {
    case "number":
      if (typeof v === "number") return Number.isFinite(v);
      if (typeof v === "bigint") return true;
      return typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v));
    case "boolean":
      if (typeof v === "boolean") return true;
      if (typeof v === "number") return v === 0 || v === 1;
      return typeof v === "string" && /^(true|false|1|0)$/i.test(v.trim());
    case "date":
      if (v instanceof Date) return !Number.isNaN(v.getTime());
      // What cleanForType leaves a date it could read: ISO, optionally with a time.
      return typeof v === "string" && /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(v.trim());
  }
}

/**
 * A value appended into an existing typed SQLite column. One that converts is
 * stored typed; one that doesn't ("see note" into REAL, "yes" into INTEGER) is kept
 * as it came — SQLite's column affinity stores it as text — instead of the
 * NULL (or false) coerceForTypedStorage would make of it. Appends aren't
 * previewed or confirmed, so nothing may be lost on the way in.
 */
function coerceForTypedAppend(v: unknown, type: LakeColumn["type"]): unknown {
  if ((type === "number" || type === "boolean") && v != null && v !== "" && !convertsLosslessly(v, type)) return coerceForStorage(v);
  return coerceForTypedStorage(v, type);
}

export function coerceForTypedStorage(v: unknown, type: LakeColumn["type"]): unknown {
  if (v == null || v === "") return null;
  switch (type) {
    case "number": {
      if (typeof v === "number") return Number.isFinite(v) ? v : null;
      if (typeof v === "bigint") return Number(v);
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    case "boolean": {
      // 0/1, not a native JS boolean — better-sqlite3 refuses to bind a
      // boolean at all ("SQLite3 can only bind numbers, strings, bigints,
      // buffers, and null", confirmed against a real bind attempt), and
      // sqlTypeForLakeColumn already declares this column INTEGER to
      // match. DuckDB's own coercion (duckdbWrite.ts's
      // coerceForTypedStorageDuckDb) returns a genuine boolean instead,
      // matching duckdbTypeForLakeColumn's native BOOLEAN column.
      let b: boolean;
      if (typeof v === "boolean") b = v;
      else if (typeof v === "string") b = v.toLowerCase() === "true" || v === "1";
      else b = Boolean(v);
      return b ? 1 : 0;
    }
    case "date":
    case "text":
    case "unknown":
    default:
      // Both engines accept a plain cleaned string for a "date" column —
      // SQLite's is TEXT; DuckDB's TIMESTAMP takes one via its own
      // implicit cast (verified against a real file). No native Date
      // object needed on the way in, only reconstructed on the way out
      // (see duckdb.ts's sanitizeDuckDbRow).
      return coerceForStorage(v);
  }
}
