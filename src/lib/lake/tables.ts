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
import { isNullToken, detectCellType, cleanForType, detectDateOrder, type CellType, type DateOrder } from "./valueClean";

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
export function qIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

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
   * Master Builder's plan-time `fk:<table>` hint (BuildTablePlan.columns[]
   * .syntheticHint), carried onto the persisted schema so downstream code
   * doesn't need the plan anymore to know a relationship exists — see
   * autoCurfMulti.ts's discoverJoins() (B7), which prefers this over
   * guessing a join from `<dim>_id` column naming. Schema-drift-added
   * columns already carried this through mergeSchemaJson(); this is the
   * same field, just also populated at initial table creation.
   */
  syntheticHint?: string;
};

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
const TYPE_VOTE_THRESHOLD = 0.9;
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
      if (isNullToken(v)) { out[c.name] = null; continue; }
      out[c.name] = cleanForType(v, c.type, { dateOrder: c.dateOrder });
    }
    return out;
  });
}

/**
 * Create a new table (or replace if exists) and seed with rows. Caller
 * is responsible for quota check before calling — this function just
 * trusts the inputs and writes them.
 *
 * Returns the inferred schema so the API layer can persist it on the
 * LakeTable Prisma row.
 */
export function createOrReplaceTable(opts: {
  tenantId: string;
  tableName: string;
  rows: Array<Record<string, unknown>>;
  sourceKind: LakeTableMeta["sourceKind"];
  sourceConfig?: Record<string, unknown>;
  /**
   * Column name -> plan-declared syntheticHint (Master Builder only —
   * uploads/webhooks/rest_pull have no plan and omit this). Applied onto
   * the inferred schema so an `fk:<table>` hint survives past this call;
   * inferColumns() itself stays plan-agnostic since it also serves callers
   * with no plan at all.
   */
  columnHints?: Record<string, string>;
  /**
   * User-confirmed type overrides from the upload preview step (see
   * /api/lake/tables/preview and TablesManager's preview dialog) — keyed by
   * column name. Wins over the inferred type for both the persisted schema
   * AND how that column's cells get cleaned below, so a user who corrects
   * "member_id" from the auto-detected "number" back to "text" actually
   * keeps their leading zeros instead of the inference silently stripping
   * them again.
   */
  columnTypeOverrides?: Record<string, LakeColumn["type"]>;
  /**
   * User-confirmed day/month order, keyed by column name. Only sent for
   * columns whose own values proved nothing either way — the preview asks
   * rather than letting the fallback decide silently.
   */
  columnDateOrders?: Record<string, DateOrder>;
}): { columns: LakeColumn[]; rowCount: number; safeName: string } {
  const db = openLake(opts.tenantId);
  const safeName = toSafeTableName(opts.tableName);
  const columns = inferColumns(opts.rows);
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
        opts.rows.map((r) => r?.[c.name]).filter((v): v is string => typeof v === "string"),
      ).order;
    }
  }
  const cleanedRows = cleanRowsForColumns(opts.rows, columns);
  const colDefs = columns.map((c) => `${qIdent(c.name)} TEXT`).join(", ");

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
        insert.run(...columns.map((c) => coerceForStorage(r?.[c.name])));
      }
    }
    upsertMeta(db, safeName, opts.sourceKind, withDateOrders(opts.sourceConfig, columns), opts.rows.length);
  });
  tx();

  return { columns, rowCount: opts.rows.length, safeName };
}

/** Append rows to an existing table, evolving the schema with new columns
 *  via ALTER TABLE. Used by both webhook and scheduled-pull paths. */
export function appendRows(opts: {
  tenantId: string;
  tableName: string;
  rows: Array<Record<string, unknown>>;
}): { added: number; newColumns: string[] } {
  const db = openLake(opts.tenantId);
  const safeName = toSafeTableName(opts.tableName);
  if (opts.rows.length === 0) return { added: 0, newColumns: [] };

  // Schema introspection: pull current columns, diff against the rows we
  // received. Any missing column triggers an ALTER TABLE ADD COLUMN.
  const existingCols = (db.prepare(`PRAGMA table_info("${safeName}")`).all() as Array<{ name: string }>)
    .map((c) => c.name);
  if (existingCols.length === 0) {
    // Table doesn't exist — fall through to create-or-replace path.
    const { rowCount } = createOrReplaceTable({
      tenantId: opts.tenantId,
      tableName: opts.tableName,
      rows: opts.rows,
      sourceKind: "webhook",
    });
    return { added: rowCount, newColumns: [] };
  }
  const incomingCols = new Set<string>();
  for (const r of opts.rows) for (const k of Object.keys(r ?? {})) incomingCols.add(k);
  const newCols = Array.from(incomingCols).filter((c) => !existingCols.includes(c));

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
  const established = schemaForTable(db, safeName);
  const hasRows = (db.prepare(`SELECT 1 FROM "${safeName}" LIMIT 1`).get() as unknown) != null;
  const batchSchema = inferColumns(opts.rows);
  const merged = hasRows
    ? batchSchema.map((bc) => established.find((ec) => ec.name === bc.name) ?? bc)
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
      insert.run(...allCols.map((c) => coerceForStorage(r?.[c])));
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
export function upsertLakeRowsByKey(opts: {
  tenantId: string;
  tableName: string;
  keyColumn: string;
  rows: Array<Record<string, unknown>>;
  /** Optional sourceKind for the meta row on first create. Defaults to "manual". */
  sourceKind?: LakeTableMeta["sourceKind"];
  /** Optional sourceConfig blob for the meta row on first create. */
  sourceConfig?: Record<string, unknown>;
}): { upserted: number; newColumns: string[] } {
  if (opts.rows.length === 0) return { upserted: 0, newColumns: [] };
  if (!opts.keyColumn) throw new Error("upsertLakeRowsByKey: keyColumn is required");
  const db = openLake(opts.tenantId);
  const safeName = toSafeTableName(opts.tableName);
  const keyCol = opts.keyColumn;

  // Schema discovery from the rows we're inserting.
  const incomingCols = new Set<string>();
  for (const r of opts.rows) for (const k of Object.keys(r ?? {})) incomingCols.add(k);
  if (!incomingCols.has(keyCol)) {
    throw new Error(`upsertLakeRowsByKey: keyColumn "${keyCol}" not present in incoming rows`);
  }

  let existingCols = (db.prepare(`PRAGMA table_info("${safeName}")`).all() as Array<{ name: string }>)
    .map((c) => c.name);
  const tableExists = existingCols.length > 0 && !(existingCols.length === 1 && existingCols[0] === "_empty");

  const tx = db.transaction(() => {
    if (!tableExists) {
      // First write — create the table with keyColumn UNIQUE. We use
      // TEXT for every column (consistent with createOrReplaceTable);
      // the runner coerces on read.
      const cols = Array.from(incomingCols);
      const colDefs = cols.map((c) => {
        if (c === keyCol) return `${qIdent(c)} TEXT UNIQUE`;
        return `${qIdent(c)} TEXT`;
      }).join(", ");
      db.prepare(`DROP TABLE IF EXISTS "${safeName}"`).run();
      db.prepare(`CREATE TABLE "${safeName}" (${colDefs})`).run();
      existingCols = cols;
      // Ensure a __lake_meta row exists so /tables surfaces this table.
      upsertMeta(db, safeName, opts.sourceKind ?? "manual", opts.sourceConfig, 0);
    } else if (!existingCols.includes(keyCol)) {
      // Pre-existing table that's missing the keyColumn — can't upsert
      // by a column the table doesn't have. Bail loudly so the caller
      // can either drop the table or pick a different keyColumn.
      throw new Error(`upsertLakeRowsByKey: existing table "${safeName}" has no "${keyCol}" column`);
    }

    // ALTER for any new columns. We don't add UNIQUE retrospectively
    // because SQLite can't via ALTER — that's fine, the keyColumn was
    // already declared UNIQUE on first create.
    const newCols = Array.from(incomingCols).filter((c) => !existingCols.includes(c) && c !== "_empty");
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
      batchUpsert.map((bc) => establishedUpsert.find((ec) => ec.name === bc.name) ?? bc),
    );
    for (const r of cleanedRows) {
      stmt.run(...allCols.map((c) => coerceForStorage(r?.[c])));
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

export function dropTable(tenantId: string, tableName: string): void {
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

export function getTable(tenantId: string, tableName: string): LakeTableMeta | null {
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
    sourceConfig: stripDateOrders(safeJson(row.source_config_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** First N rows for the preview pane. Defaults to 50 — comfortable cap
 *  for the UI to render in a normal table layout. Optional offset supports
 *  paging from the v1 /lake/tables/[name]/rows endpoint. */
export function previewRows(
  tenantId: string,
  tableName: string,
  limit = 50,
  offset = 0,
): any[] {
  const db = openLake(tenantId);
  const safeName = toSafeTableName(tableName);
  const cappedLimit = Math.min(limit, 500);
  const cappedOffset = Math.max(0, offset | 0);
  return db
    .prepare(`SELECT * FROM "${safeName}" LIMIT ? OFFSET ?`)
    .all(cappedLimit, cappedOffset) as any[];
}

/** Count rows for accurate quota + UI display. */
export function rowCount(tenantId: string, tableName: string): number {
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
 */
export function distinctColumnValues(
  tenantId: string,
  tableName: string,
  columnName: string,
  limit = 500,
): string[] {
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
export function addColumn(opts: {
  tenantId: string;
  tableName: string;
  columnName: string;
  defaultValue?: string;
}): void {
  const db = openLake(opts.tenantId);
  const safeTable = toSafeTableName(opts.tableName);
  // SQLite identifier sanitisation — letters/digits/underscores only,
  // first char a letter. Rejects bobby-tables shenanigans cleanly.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(opts.columnName)) {
    throw new Error("Column name must match [a-zA-Z_][a-zA-Z0-9_]*");
  }
  // Existence check first so we get a friendlier error than SQLITE_ERROR.
  const existing = (db.prepare(`PRAGMA table_info("${safeTable}")`).all() as any[])
    .map((c: any) => c.name);
  if (existing.includes(opts.columnName)) {
    throw new Error(`Column "${opts.columnName}" already exists`);
  }
  // ALTER TABLE ADD COLUMN ... DEFAULT 'val' uses a literal default;
  // we always store TEXT so the default goes through as a string.
  const defClause = opts.defaultValue != null
    ? ` DEFAULT '${String(opts.defaultValue).replace(/'/g, "''")}'`
    : "";
  db.prepare(`ALTER TABLE "${safeTable}" ADD COLUMN "${opts.columnName}" TEXT${defClause}`).run();
  bumpMetaUpdatedAt(db, safeTable);
}

/**
 * Rename a column. Available in SQLite 3.25+ via ALTER TABLE RENAME COLUMN
 * (which better-sqlite3 ships with). Requires no rebuild.
 */
export function renameColumn(opts: {
  tenantId: string;
  tableName: string;
  oldName: string;
  newName: string;
}): void {
  const db = openLake(opts.tenantId);
  const safeTable = toSafeTableName(opts.tableName);
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(opts.newName)) {
    throw new Error("New column name must match [a-zA-Z_][a-zA-Z0-9_]*");
  }
  const existing = (db.prepare(`PRAGMA table_info("${safeTable}")`).all() as any[])
    .map((c: any) => c.name);
  if (!existing.includes(opts.oldName)) throw new Error(`Column "${opts.oldName}" not found`);
  if (existing.includes(opts.newName)) throw new Error(`Column "${opts.newName}" already exists`);
  db.prepare(`ALTER TABLE "${safeTable}" RENAME COLUMN "${opts.oldName}" TO "${opts.newName}"`).run();
  bumpMetaUpdatedAt(db, safeTable);
}

/**
 * Drop a column. SQLite 3.35+ supports ALTER TABLE DROP COLUMN natively
 * (better-sqlite3 ships modern enough). Older SQLite would need the
 * create-new-table-and-copy dance, which we don't need to support yet.
 */
export function dropColumn(opts: {
  tenantId: string;
  tableName: string;
  columnName: string;
}): void {
  const db = openLake(opts.tenantId);
  const safeTable = toSafeTableName(opts.tableName);
  const existing = (db.prepare(`PRAGMA table_info("${safeTable}")`).all() as any[])
    .map((c: any) => c.name);
  if (!existing.includes(opts.columnName)) throw new Error(`Column "${opts.columnName}" not found`);
  if (existing.length <= 1) throw new Error("Cannot drop the last column");
  db.prepare(`ALTER TABLE "${safeTable}" DROP COLUMN "${opts.columnName}"`).run();
  bumpMetaUpdatedAt(db, safeTable);
}

function bumpMetaUpdatedAt(db: DB, tableName: string): void {
  db.prepare(`UPDATE __lake_meta SET updated_at = datetime('now') WHERE table_name = ?`).run(tableName);
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
export function retypeColumn(opts: {
  tenantId: string;
  tableName: string;
  columnName: string;
  type: Exclude<LakeColumn["type"], "unknown">;
  /** Overrides the order detected from the column's own values. */
  dateOrder?: DateOrder;
}): { updated: number; unchanged: number } {
  const db = openLake(opts.tenantId);
  const safeTable = toSafeTableName(opts.tableName);
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
      if (row.v == null) { unchanged++; continue; }
      if (isNullToken(row.v)) {
        // A leftover "N/A"/"-"/etc from before this feature existed — clean
        // it to a real NULL regardless of target type.
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
// Internal helpers
// ---------------------------------------------------------------------------

function upsertMeta(db: DB, tableName: string, kind: string, config: any, count: number): void {
  db.prepare(`
    INSERT INTO __lake_meta (table_name, source_kind, source_config_json, row_count, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(table_name) DO UPDATE SET
      source_kind = excluded.source_kind,
      source_config_json = excluded.source_config_json,
      row_count = excluded.row_count,
      updated_at = datetime('now')
  `).run(tableName, kind, config ? JSON.stringify(config) : null, count);
}

function bumpMeta(db: DB, tableName: string, addedRows: number): void {
  db.prepare(`
    UPDATE __lake_meta
    SET row_count = row_count + ?, updated_at = datetime('now')
    WHERE table_name = ?
  `).run(addedRows, tableName);
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
const DATE_ORDERS_KEY = "__dateOrders";

function withDateOrders(config: any, columns: LakeColumn[]): any {
  const orders: Record<string, DateOrder> = {};
  for (const c of columns) if (c.type === "date" && c.dateOrder) orders[c.name] = c.dateOrder;
  if (Object.keys(orders).length === 0) return config;
  return { ...(config ?? {}), [DATE_ORDERS_KEY]: orders };
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

function stripDateOrders(config: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!config || !(DATE_ORDERS_KEY in config)) return config;
  const { [DATE_ORDERS_KEY]: _omit, ...rest } = config;
  return rest;
}

function readDateOrders(db: DB, tableName: string): Record<string, DateOrder> {
  const row = db.prepare(`SELECT source_config_json FROM __lake_meta WHERE table_name = ?`).get(tableName) as any;
  const cfg = safeJson(row?.source_config_json);
  const orders = cfg?.[DATE_ORDERS_KEY];
  return orders && typeof orders === "object" ? orders as Record<string, DateOrder> : {};
}

function schemaForTable(db: DB, tableName: string): LakeColumn[] {
  const cols = db.prepare(`PRAGMA table_info("${tableName}")`).all() as any[];
  // For a freshly-created table we have a real preview; fall back to
  // text-typed everything when there are zero rows.
  const sample = db.prepare(`SELECT * FROM "${tableName}" LIMIT 100`).all();
  if (sample.length === 0) {
    return cols.map((c: any) => ({ name: c.name, type: "text" as const }));
  }
  const inferred = inferColumns(sample as any[]);
  // Restore each date column's stored order over the one just re-inferred
  // from ISO values, which can only ever be the fallback.
  const orders = readDateOrders(db, tableName);
  for (const c of inferred) if (c.type === "date" && orders[c.name]) c.dateOrder = orders[c.name];
  return inferred;
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
function coerceForStorage(v: unknown): string | null {
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
