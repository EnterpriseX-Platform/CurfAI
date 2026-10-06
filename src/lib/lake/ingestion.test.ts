/**
 * End-to-end ingestion behaviour: inferColumns' majority vote, and — the
 * part that actually matters for query correctness — that
 * createOrReplaceTable/appendRows/upsertLakeRowsByKey write the CLEANED
 * value to disk, not the raw one. Classifying a column "number" without
 * also cleaning "$1,299.00" down to "1299" is cosmetic: every generated
 * aggregate does SUM(CAST(col AS REAL)), and SQLite's CAST-to-REAL returns
 * 0 for a string that doesn't start with a digit — so these tests read
 * back through a real SQLite CAST, not just the JS-level return value, to
 * prove the fix actually reaches the number a report would compute.
 *
 * Same in-memory-db harness as tables.test.ts (distinctColumnValues).
 *
 * createOrReplaceTable/appendRows/dropTable are async (see their doc
 * comments in tables.ts — a paid lake engine writes through ee.lake
 * instead of this tenant's SQLite file). ee.lake is mocked absent here so
 * every test in this file exercises the plain SQLite/Community path,
 * exactly like before those functions gained an engine check.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import Database from "better-sqlite3";

let db: InstanceType<typeof Database>;

vi.mock("./storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./storage")>();
  return { ...actual, openLake: () => db };
});

vi.mock("@/ee", () => ({ ee: {} }));

import {
  inferColumns, createOrReplaceTable, cleanRowsForColumns, retypeColumn,
  appendRows, upsertLakeRowsByKey, getTable, qIdent,
  addColumn, renameColumn, dropColumn, rekeyDateOrder,
  previewTypedConversion, applyTypedConversion,
  TypedConversionDriftError, isTypedConversionDriftError,
} from "./tables";

function freshDb() {
  db = new Database(":memory:");
  // Real openLake() bootstraps this lazily (storage.ts's bootstrapMeta,
  // internal/unexported); createOrReplaceTable writes to it via upsertMeta,
  // so the mocked in-memory db needs the same table up front. DDL mirrored
  // verbatim from storage.ts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS __lake_meta (
      table_name TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,
      source_config_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      row_count INTEGER NOT NULL DEFAULT 0
    )
  `);
}

describe("inferColumns — majority vote replaces first-mismatch-wins", () => {
  it("one stray N/A no longer poisons an otherwise-clean numeric column", () => {
    const rows = [{ amount: "100" }, { amount: "N/A" }, { amount: "375" }, { amount: "220" }];
    expect(inferColumns(rows)).toEqual([
      expect.objectContaining({ name: "amount", type: "number" }),
    ]);
  });

  it("currency-formatted values classify as number", () => {
    const rows = [{ price: "$1,299.00" }, { price: "$899.50" }, { price: "$45.00" }];
    expect(inferColumns(rows)[0].type).toBe("number");
  });

  it("US slash dates classify as date", () => {
    const rows = [{ d: "01/15/2024" }, { d: "02/20/2024" }, { d: "03/01/2024" }];
    expect(inferColumns(rows)[0].type).toBe("date");
  });

  it("a genuinely mixed column still correctly stays text", () => {
    const rows = [{ v: "100" }, { v: "widget" }, { v: "42" }, { v: "gadget" }, { v: "7" }];
    expect(inferColumns(rows)[0].type).toBe("text");
  });

  it("a column empty for the first many rows is still typed once real values appear", () => {
    const rows = [
      ...Array.from({ length: 50 }, () => ({ id: "x", late: "" })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: "x", late: String(i) })),
    ];
    expect(inferColumns(rows).find((c) => c.name === "late")?.type).toBe("number");
  });

  it("a leading-zero column (ZIP-code shaped) is NOT classified as number", () => {
    const rows = [{ zip: "00501" }, { zip: "10001" }, { zip: "90210" }];
    // 00501 fails the number test; 10001/90210 pass — under 90% supermajority
    // this must fall back to text rather than mangle the leading zero.
    expect(inferColumns(rows)[0].type).toBe("text");
  });
});

describe("createOrReplaceTable — cleaned values actually land on disk", () => {
  it("a currency-formatted column sums correctly through SQLite's own CAST", async () => {
    freshDb();
    await createOrReplaceTable({
      tenantId: "t1", tableName: "sales",
      rows: [{ price: "$1,299.00" }, { price: "$899.50" }],
      sourceKind: "upload",
    });
    // This is the actual failure mode: SUM(CAST(col AS REAL)) is exactly
    // what autoCurf.ts generates for every KPI. Against the OLD raw
    // "$1,299.00" text this returns 0, not 2198.5.
    const row = db.prepare(`SELECT SUM(CAST(${qIdent("price")} AS REAL)) AS total FROM "sales"`).get() as any;
    expect(row.total).toBeCloseTo(2198.5, 2);
  });

  it("a thousands-separated column sums correctly", async () => {
    freshDb();
    await createOrReplaceTable({
      tenantId: "t1", tableName: "t",
      rows: [{ units: "1,234" }, { units: "5,678" }],
      sourceKind: "upload",
    });
    const row = db.prepare(`SELECT SUM(CAST(${qIdent("units")} AS REAL)) AS total FROM "t"`).get() as any;
    expect(row.total).toBe(6912);
  });

  it("a stray N/A becomes a real NULL, not the literal text 'N/A'", async () => {
    freshDb();
    await createOrReplaceTable({
      tenantId: "t1", tableName: "t",
      rows: [{ amount: "100" }, { amount: "N/A" }, { amount: "300" }],
      sourceKind: "upload",
    });
    const rows = db.prepare(`SELECT ${qIdent("amount")} AS v FROM "t" ORDER BY rowid`).all() as any[];
    expect(rows.map((r) => r.v)).toEqual(["100", null, "300"]);
  });

  it("a ZIP-code-shaped column keeps its leading zero on disk", async () => {
    freshDb();
    await createOrReplaceTable({
      tenantId: "t1", tableName: "t",
      rows: [{ zip: "00501" }],
      sourceKind: "upload",
    });
    const row = db.prepare(`SELECT ${qIdent("zip")} AS v FROM "t"`).get() as any;
    expect(row.v).toBe("00501");
  });

  it("a slash date is stored as canonical ISO, not the original text", async () => {
    freshDb();
    await createOrReplaceTable({
      tenantId: "t1", tableName: "t",
      rows: [{ d: "01/15/2024" }],
      sourceKind: "upload",
    });
    const row = db.prepare(`SELECT ${qIdent("d")} AS v FROM "t"`).get() as any;
    expect(row.v).toBe("2024-01-15");
  });

  it("columnTypeOverrides wins over inference — and changes how the value is cleaned", async () => {
    freshDb();
    // "$1,234" alone would infer + clean as number ("1234"). Forcing text
    // via override must both persist "text" as the type AND skip the
    // numeric cleaning, leaving the original formatting intact — proving
    // the override drives the cleaning pass, not just the schema label.
    const { columns } = await createOrReplaceTable({
      tenantId: "t1", tableName: "t",
      rows: [{ code: "$1,234" }],
      sourceKind: "upload",
      columnTypeOverrides: { code: "text" },
    });
    expect(columns[0].type).toBe("text");
    const row = db.prepare(`SELECT ${qIdent("code")} AS v FROM "t"`).get() as any;
    expect(row.v).toBe("$1,234");
  });
});

describe("cleanRowsForColumns", () => {
  it("never mutates the input rows", () => {
    const rows = [{ price: "$100" }];
    const columns = inferColumns(rows);
    cleanRowsForColumns(rows, columns);
    expect(rows[0].price).toBe("$100");
  });

  it("leaves non-string values (already-native JSON types) untouched", () => {
    const rows = [{ amount: 1299.5, active: true }];
    const columns = inferColumns(rows);
    const cleaned = cleanRowsForColumns(rows, columns);
    expect(cleaned[0].amount).toBe(1299.5);
    expect(cleaned[0].active).toBe(true);
  });

  /**
   * Live data loss: a 77-province upload stored 76. "nan" is Nan province's
   * English slug, and it sat in the null-token denylist meant for numeric
   * columns. Nothing surfaced it — inference skips the same tokens when
   * voting, so the column still read type "text", sample "phayao".
   */
  it("keeps denylist tokens that are real values in a text column", () => {
    const rows = [
      { slug: "phayao" }, { slug: "nan" }, { slug: "na" },
      { slug: "none" }, { slug: "unknown" }, { slug: "-" },
    ];
    const columns = inferColumns(rows);
    expect(columns[0].type).toBe("text");
    const cleaned = cleanRowsForColumns(rows, columns);
    expect(cleaned.map((r) => r.slug)).toEqual(["phayao", "nan", "na", "none", "unknown", "-"]);
  });

  it("still nulls an empty cell in a text column", () => {
    const rows = [{ slug: "phayao" }, { slug: "   " }];
    const cleaned = cleanRowsForColumns(rows, inferColumns(rows));
    expect(cleaned[1].slug).toBeNull();
  });

  it("still treats N/A as missing in a NUMBER column — the case the denylist is for", () => {
    const rows = [{ amount: "100" }, { amount: "250" }, { amount: "N/A" }, { amount: "-" }];
    const columns = inferColumns(rows);
    expect(columns[0].type).toBe("number");
    const cleaned = cleanRowsForColumns(rows, columns);
    expect(cleaned.map((r) => r.amount)).toEqual(["100", "250", null, null]);
  });
});

describe("appendRows — the same cleaning applies to a scheduled pull's batch", () => {
  it("cleans a currency-formatted append batch", async () => {
    freshDb();
    await createOrReplaceTable({
      tenantId: "t1", tableName: "t", rows: [{ price: "100" }], sourceKind: "upload",
    });
    await appendRows({ tenantId: "t1", tableName: "t", rows: [{ price: "$250.00" }] });
    const row = db.prepare(`SELECT SUM(CAST(${qIdent("price")} AS REAL)) AS total FROM "t"`).get() as any;
    expect(row.total).toBe(350);
  });
});

describe("retypeColumn — recovery for a mistyped or pre-existing column", () => {
  it("cleans every cell to the new type and reports how many changed", async () => {
    freshDb();
    await createOrReplaceTable({
      tenantId: "t1", tableName: "t",
      rows: [{ v: "$100" }, { v: "$200" }, { v: "not a number" }],
      sourceKind: "upload",
      columnTypeOverrides: { v: "text" }, // simulate a table stored raw, pre-feature
    });
    const result = await retypeColumn({ tenantId: "t1", tableName: "t", columnName: "v", type: "number" });
    expect(result.updated).toBe(2); // the two currency values clean
    expect(result.unchanged).toBe(1); // "not a number" can't clean, stays as-is

    const rows = db.prepare(`SELECT ${qIdent("v")} AS x FROM "t" ORDER BY rowid`).all() as any[];
    expect(rows.map((r) => r.x)).toEqual(["100", "200", "not a number"]);
  });

  it("cleans a stale null-token left over from before this feature existed", async () => {
    freshDb();
    await createOrReplaceTable({
      tenantId: "t1", tableName: "t", rows: [{ v: "100" }], sourceKind: "upload",
    });
    // createOrReplaceTable now null-tokens "N/A" on ingest regardless of
    // column type, so a legacy pre-feature table is the only realistic way
    // to see raw "N/A" on disk — simulate it by writing directly, as a
    // table created before this cleaning shipped would actually look.
    db.prepare(`UPDATE "t" SET ${qIdent("v")} = 'N/A' WHERE rowid = 1`).run();
    expect((db.prepare(`SELECT ${qIdent("v")} AS x FROM "t"`).get() as any).x).toBe("N/A");
    await retypeColumn({ tenantId: "t1", tableName: "t", columnName: "v", type: "number" });
    expect((db.prepare(`SELECT ${qIdent("v")} AS x FROM "t"`).get() as any).x).toBeNull();
  });

  it("throws for a column that doesn't exist", async () => {
    freshDb();
    await createOrReplaceTable({ tenantId: "t1", tableName: "t", rows: [{ a: "1" }], sourceKind: "upload" });
    await expect(retypeColumn({ tenantId: "t1", tableName: "t", columnName: "nope", type: "number" }))
      .rejects.toThrow(/not found/);
  });

  it("retyping to text is a safe no-op recovery for a mangled numeric column", async () => {
    freshDb();
    await createOrReplaceTable({
      tenantId: "t1", tableName: "t", rows: [{ v: "42" }], sourceKind: "upload",
    });
    const result = await retypeColumn({ tenantId: "t1", tableName: "t", columnName: "v", type: "text" });
    expect(result.unchanged).toBe(1);
  });
});

describe("date order end-to-end — a day-first column survives ingest", () => {
  it("types a day-first column as date and stores real ISO dates", async () => {
    freshDb();
    // Under the old month-first-only parser every one of these but 03/04
    // failed to parse, so the column lost its vote and landed as text.
    await createOrReplaceTable({
      tenantId: "t1",
      tableName: "invoices",
      rows: [
        { issued: "03/04/2024" }, { issued: "13/04/2024" },
        { issued: "25/12/2024" }, { issued: "17/07/2024" },
      ],
      sourceKind: "upload",
    });
    const stored = db.prepare(`SELECT ${qIdent("issued")} AS v FROM "invoices"`).all() as any[];
    expect(stored.map((r) => r.v)).toEqual([
      "2024-04-03", "2024-04-13", "2024-12-25", "2024-07-17",
    ]);
  });

  it("carries the detected order on the schema so it isn't re-guessed later", () => {
    const cols = inferColumns([{ d: "13/04/2024" }, { d: "03/04/2024" }]);
    expect(cols[0]).toMatchObject({ name: "d", type: "date", dateOrder: "dmy" });
  });

  it("retype to date reads the column's own values to pick the order", async () => {
    freshDb();
    // Land raw text first, then retype — the pre-existing-table recovery path.
    await createOrReplaceTable({
      tenantId: "t1", tableName: "legacy",
      rows: [{ d: "x" }], sourceKind: "upload",
    });
    const ins = db.prepare(`INSERT INTO "legacy" (${qIdent("d")}) VALUES (?)`);
    db.prepare(`DELETE FROM "legacy"`).run();
    for (const v of ["03/04/2024", "28/02/2024"]) ins.run(v);

    await retypeColumn({ tenantId: "t1", tableName: "legacy", columnName: "d", type: "date" });
    const stored = db.prepare(`SELECT ${qIdent("d")} AS v FROM "legacy"`).all() as any[];
    // 28 proves day-first, so 03/04 must read as 3 April — not 4 March.
    expect(stored.map((r) => r.v)).toEqual(["2024-04-03", "2024-02-28"]);
  });
});

describe("appendRows / upsert — the table's type wins over the batch's", () => {
  it("does not retype an established text column because one batch looks numeric", async () => {
    freshDb();
    // Reference codes: text, and some of them have leading zeros.
    await createOrReplaceTable({
      tenantId: "t1", tableName: "refs",
      rows: [{ code: "00501" }, { code: "A-22" }, { code: "00777" }],
      sourceKind: "webhook",
    });
    // A later batch happens to be all plainly-numeric-looking with commas.
    await appendRows({ tenantId: "t1", tableName: "refs", rows: [{ code: "1,234" }] });
    const stored = db.prepare(`SELECT ${qIdent("code")} AS v FROM "refs"`).all() as any[];
    // Batch-local inference would have called this column number and
    // stripped the comma, leaving "1234" among untouched "A-22"/"00501".
    expect(stored.map((r) => r.v)).toEqual(["00501", "A-22", "00777", "1,234"]);
  });

  it("keeps the table's established day/month order when a batch can't prove one", async () => {
    freshDb();
    await createOrReplaceTable({
      tenantId: "t1", tableName: "events",
      rows: [{ at: "25/12/2024" }, { at: "13/04/2024" }],  // proves day-first
      sourceKind: "webhook",
    });
    // This batch alone is ambiguous and would have defaulted to month-first.
    await appendRows({ tenantId: "t1", tableName: "events", rows: [{ at: "03/04/2024" }] });
    const stored = db.prepare(`SELECT ${qIdent("at")} AS v FROM "events"`).all() as any[];
    expect(stored[2].v).toBe("2024-04-03");
  });

  it("still lets the batch decide a column the table doesn't have yet", async () => {
    freshDb();
    await createOrReplaceTable({
      tenantId: "t1", tableName: "widgets",
      rows: [{ sku: "A1" }], sourceKind: "webhook",
    });
    await appendRows({ tenantId: "t1", tableName: "widgets", rows: [{ sku: "B2", price: "$1,299.00" }] });
    const stored = db.prepare(`SELECT ${qIdent("price")} AS v FROM "widgets" WHERE ${qIdent("sku")} = 'B2'`).get() as any;
    expect(stored.v).toBe("1299");
  });
});

describe("appendRows / upsertLakeRowsByKey — writing into an EXISTING typed table (E1b Phase C)", () => {
  const ORIGINAL_FLAG = process.env.CURF_LAKE_TYPED_COLUMNS;
  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.CURF_LAKE_TYPED_COLUMNS;
    else process.env.CURF_LAKE_TYPED_COLUMNS = ORIGINAL_FLAG;
  });

  it("getTable (schemaForTable) reports boolean for an INTEGER 0/1 column, not number", async () => {
    process.env.CURF_LAKE_TYPED_COLUMNS = "true";
    freshDb();
    await createOrReplaceTable({
      tenantId: "t1", tableName: "subs",
      rows: [{ active: "true" }, { active: "false" }],
      sourceKind: "upload",
      columnTypeOverrides: { active: "boolean" },
    });
    // Pre-fix, sample-based re-inference would see two JS numbers (0/1) —
    // typeOf() has no way to tell a boolean-as-INTEGER apart from a
    // genuine small number by value alone — and mislabel this "number".
    const meta = (await getTable("t1", "subs"))!;
    expect(meta.columns.find((c) => c.name === "active")).toMatchObject({ type: "boolean" });
  });

  it("appendRows writes a native REAL/INTEGER into an existing typed table's columns", async () => {
    process.env.CURF_LAKE_TYPED_COLUMNS = "true";
    freshDb();
    await createOrReplaceTable({
      tenantId: "t1", tableName: "subs",
      rows: [{ amount: "100", active: "true" }],
      sourceKind: "upload",
      columnTypeOverrides: { amount: "number", active: "boolean" },
    });
    await appendRows({ tenantId: "t1", tableName: "subs", rows: [{ amount: "$250.00", active: "false" }] });
    const rows = db.prepare(`SELECT ${qIdent("amount")} AS amount, ${qIdent("active")} AS active FROM "subs" ORDER BY rowid`).all() as any[];
    expect(rows[1].amount).toBe(250);
    expect(typeof rows[1].amount).toBe("number");
    expect(rows[1].active).toBe(0); // SQLite has no native boolean — INTEGER 0/1
  });

  it("appendRows handles a mixed batch: an existing typed column plus a brand-new column together", async () => {
    process.env.CURF_LAKE_TYPED_COLUMNS = "true";
    freshDb();
    await createOrReplaceTable({
      tenantId: "t1", tableName: "subs",
      rows: [{ amount: "100" }],
      sourceKind: "upload",
      columnTypeOverrides: { amount: "number" },
    });
    await appendRows({ tenantId: "t1", tableName: "subs", rows: [{ amount: "$50.00", plan: "enterprise" }] });
    const row = db.prepare(`SELECT ${qIdent("amount")} AS amount, ${qIdent("plan")} AS plan FROM "subs" WHERE rowid = 2`).get() as any;
    expect(row.amount).toBe(50);
    expect(typeof row.amount).toBe("number");
    expect(row.plan).toBe("enterprise");
    // "plan" is brand new this batch — always ALTER'd in as TEXT, never
    // inferred as typed DDL, regardless of the flag.
    const ddl = db.prepare(`PRAGMA table_info("subs")`).all() as Array<{ name: string; type: string }>;
    expect(ddl.find((c) => c.name === "plan")?.type).toBe("TEXT");
  });

  it("upsertLakeRowsByKey writes a native value into an existing typed table's columns", async () => {
    process.env.CURF_LAKE_TYPED_COLUMNS = "true";
    freshDb();
    await createOrReplaceTable({
      tenantId: "t1", tableName: "subs",
      // "id" is deliberately non-numeric-looking so it infers as text —
      // this test is about the "amount" column's typed coercion, and a
      // typed "id" column would drag DDL-affinity string/number
      // comparison quirks into an assertion that isn't about that.
      rows: [{ id: "row-a", amount: "100" }],
      sourceKind: "upload",
      columnTypeOverrides: { amount: "number" },
    });
    // createOrReplaceTable's own create path never adds a UNIQUE
    // constraint on "id" — upsertLakeRowsByKey's own ensureUpsertKeyIndex
    // retrofits one on demand (see the dedicated describe block below for
    // that fix's own coverage), so no manual setup is needed here.
    await upsertLakeRowsByKey({
      tenantId: "t1", tableName: "subs", keyColumn: "id", rows: [{ id: "row-b", amount: "$75.50" }],
    });
    const row = db.prepare(`SELECT ${qIdent("amount")} AS amount FROM "subs" WHERE ${qIdent("id")} = 'row-b'`).get() as any;
    expect(row.amount).toBe(75.5);
    expect(typeof row.amount).toBe("number");
  });

  it("upsertLakeRowsByKey's own first-create path emits typed DDL too, now that it's flag-aware", async () => {
    process.env.CURF_LAKE_TYPED_COLUMNS = "true";
    freshDb();
    await upsertLakeRowsByKey({
      tenantId: "t1", tableName: "brand_new", keyColumn: "id", rows: [{ id: "row-a", amount: "100", active: "true" }],
    });
    const ddl = Object.fromEntries(
      (db.prepare(`PRAGMA table_info("brand_new")`).all() as Array<{ name: string; type: string }>).map((c) => [c.name, c.type]),
    );
    expect(ddl.id).toBe("TEXT");
    expect(ddl.amount).toBe("REAL");
    expect(ddl.active).toBe("INTEGER");
    // The first batch's own values must round-trip as natives too, not
    // just the DDL — the map that drives write-time coercion is built
    // from a pre-creation PRAGMA read and has to be repopulated after
    // CREATE TABLE for this to work on the very first insert.
    const row = db.prepare(`SELECT amount, active FROM "brand_new" WHERE id = 'row-a'`).get() as any;
    expect(row.amount).toBe(100);
    expect(typeof row.amount).toBe("number");
    expect(row.active).toBe(1);
  });

  it("upsertLakeRowsByKey's own first-create path stays TEXT with the flag off — no behavior change from before this fix", async () => {
    delete process.env.CURF_LAKE_TYPED_COLUMNS;
    freshDb();
    await upsertLakeRowsByKey({
      tenantId: "t1", tableName: "brand_new", keyColumn: "id", rows: [{ id: "1", amount: "100" }],
    });
    const ddl = db.prepare(`PRAGMA table_info("brand_new")`).all() as Array<{ name: string; type: string }>;
    for (const col of ddl) expect(col.type).toBe("TEXT");
  });
});

describe("upsertLakeRowsByKey — works against a pre-existing table lacking a UNIQUE key constraint", () => {
  // Pre-existing bug, unrelated to E1b's typed-columns work: only this
  // function's own !tableExists branch ever declared keyCol UNIQUE. A
  // table that reached upsertLakeRowsByKey some other way (an upload via
  // createOrReplaceTable, here) had none, and its ON CONFLICT(keyCol)
  // insert threw "does not match any PRIMARY KEY or UNIQUE constraint"
  // instead of upserting. Fixed by ensureUpsertKeyIndex, which retrofits
  // the constraint the first time it's missing.
  it("upserts correctly into a table createOrReplaceTable created, with no manual setup", async () => {
    freshDb();
    await createOrReplaceTable({
      tenantId: "t1", tableName: "customers",
      rows: [{ id: "1", name: "Alice" }], sourceKind: "upload",
    });
    await upsertLakeRowsByKey({ tenantId: "t1", tableName: "customers", keyColumn: "id", rows: [{ id: "2", name: "Bob" }] });
    await upsertLakeRowsByKey({ tenantId: "t1", tableName: "customers", keyColumn: "id", rows: [{ id: "1", name: "Alice Updated" }] });
    const rows = db.prepare(`SELECT id, name FROM "customers" ORDER BY id`).all() as any[];
    expect(rows).toEqual([{ id: "1", name: "Alice Updated" }, { id: "2", name: "Bob" }]);
  });

  it("throws a clear domain error, not a raw SQLite error, when the key column already has duplicate values", async () => {
    freshDb();
    await createOrReplaceTable({
      tenantId: "t1", tableName: "customers",
      rows: [{ id: "1", name: "Alice" }, { id: "1", name: "Alice Duplicate" }], sourceKind: "upload",
    });
    await expect(upsertLakeRowsByKey({ tenantId: "t1", tableName: "customers", keyColumn: "id", rows: [{ id: "2", name: "Bob" }] }))
      .rejects.toThrow(/duplicate values/);
  });
});

describe("previewTypedConversion / applyTypedConversion — E1b Phase D (D1: SQLite rebuild primitive)", () => {
  const ORIGINAL_FLAG = process.env.CURF_LAKE_TYPED_COLUMNS;
  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.CURF_LAKE_TYPED_COLUMNS;
    else process.env.CURF_LAKE_TYPED_COLUMNS = ORIGINAL_FLAG;
  });

  // A table that predates typed columns entirely — created with the flag
  // off, same as every real table today. 11 rows so the 90% majority-vote
  // threshold reliably clears "amount"/"active" despite one deliberately
  // bad value in each (same padding rationale as typedColumns.test.ts).
  // "signed_up" is a clean date column (should be SKIPPED — no physical
  // rebuild needed for date on SQLite) and "plan" is genuinely text.
  async function seedLegacyTable() {
    delete process.env.CURF_LAKE_TYPED_COLUMNS;
    freshDb();
    const rows = [
      { id: "row-0", amount: "$1,299.00", active: "true", signed_up: "01/15/2026", plan: "enterprise" },
      { id: "row-1", amount: "$49.50", active: "false", signed_up: "03/02/2026", plan: "starter" },
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `row-${i + 2}`, amount: `$${(i + 1) * 10}.00`, active: i % 2 === 0 ? "true" : "false",
        signed_up: `05/1${i}/2026`, plan: "team",
      })),
      // Deliberately bad: "not a number" nulls under Option C's number
      // rule; "maybe" is neither "true" nor "false" and silently becomes
      // false under Option C's (different!) boolean rule.
      { id: "row-10", amount: "not a number", active: "maybe", signed_up: "06/20/2026", plan: "business" },
    ];
    await createOrReplaceTable({ tenantId: "t1", tableName: "subs", rows, sourceKind: "upload" });
  }

  it("preview identifies eligible columns, skips date/text columns with reasons, and full-scans for exact lossy cells", async () => {
    await seedLegacyTable();
    const preview = await previewTypedConversion({ tenantId: "t1", tableName: "subs" });

    expect(preview.totalRows).toBe(11);
    const byName = Object.fromEntries(preview.eligibleColumns.map((c) => [c.name, c]));
    expect(byName.amount).toMatchObject({ proposedType: "number", lossyCells: 1, consideredCells: 11 });
    expect(byName.amount.sampleLossyValues).toEqual(["not a number"]);
    expect(byName.active).toMatchObject({ proposedType: "boolean", lossyCells: 1, consideredCells: 11 });
    expect(byName.active.sampleLossyValues).toEqual(["maybe"]);

    const skippedByName = Object.fromEntries(preview.skippedColumns.map((c) => [c.name, c.reason]));
    expect(skippedByName.signed_up).toMatch(/no physical rebuild.*retypeColumn/);
    expect(skippedByName.plan).toMatch(/90% majority/);
    expect(skippedByName.id).toMatch(/90% majority/);
  });

  it("preview never mutates anything, regardless of typedColumnsEnabled()", async () => {
    await seedLegacyTable();
    await previewTypedConversion({ tenantId: "t1", tableName: "subs" });
    const ddl = db.prepare(`PRAGMA table_info("subs")`).all() as Array<{ name: string; type: string }>;
    for (const col of ddl) expect(col.type).toBe("TEXT");
  });

  it("apply throws if CURF_LAKE_TYPED_COLUMNS isn't enabled", async () => {
    await seedLegacyTable();
    await expect(applyTypedConversion({ tenantId: "t1", tableName: "subs" })).rejects.toThrow(/not enabled/);
  });

  it("apply rebuilds eligible columns' DDL, writes native values, and reports the same lossyCells preview found", async () => {
    await seedLegacyTable();
    process.env.CURF_LAKE_TYPED_COLUMNS = "true";

    const result = await applyTypedConversion({ tenantId: "t1", tableName: "subs" });
    expect(result.convertedColumns.sort()).toEqual(["active", "amount"]);
    expect(result.lossyCells).toBe(2); // 1 from amount + 1 from active — matches the preview exactly

    const ddl = Object.fromEntries(
      (db.prepare(`PRAGMA table_info("subs")`).all() as Array<{ name: string; type: string }>).map((c) => [c.name, c.type]),
    );
    expect(ddl.amount).toBe("REAL");
    expect(ddl.active).toBe("INTEGER");
    expect(ddl.signed_up).toBe("TEXT"); // untouched — date needs no rebuild
    expect(ddl.plan).toBe("TEXT"); // untouched — genuinely text
    expect(ddl.id).toBe("TEXT"); // untouched — genuinely text

    const rows = db.prepare(`SELECT id, amount, active, signed_up, plan FROM "subs" ORDER BY id`).all() as any[];
    const row0 = rows.find((r) => r.id === "row-0");
    expect(row0.amount).toBe(1299);
    expect(typeof row0.amount).toBe("number");
    expect(row0.active).toBe(1); // SQLite has no native boolean — INTEGER 0/1
    expect(row0.signed_up).toBe("2026-01-15"); // untouched, still canonical ISO text from ingest

    const badRow = rows.find((r) => r.id === "row-10");
    expect(badRow.amount).toBeNull(); // "not a number" — Option C: nulled
    expect(badRow.active).toBe(0); // "maybe" — Option C: silently false, NOT null
    expect(badRow.plan).toBe("business"); // untouched text survives verbatim

    // The result's returned schema reflects the rebuilt table directly —
    // a future route can persist this straight to LakeTable.schemaJson.
    expect(result.columns.find((c) => c.name === "amount")?.type).toBe("number");
    expect(result.columns.find((c) => c.name === "active")?.type).toBe("boolean");
  });

  it("apply only touches the columns explicitly requested, leaving other eligible columns untouched", async () => {
    await seedLegacyTable();
    process.env.CURF_LAKE_TYPED_COLUMNS = "true";

    const result = await applyTypedConversion({ tenantId: "t1", tableName: "subs", columns: ["amount"] });
    expect(result.convertedColumns).toEqual(["amount"]);

    const ddl = Object.fromEntries(
      (db.prepare(`PRAGMA table_info("subs")`).all() as Array<{ name: string; type: string }>).map((c) => [c.name, c.type]),
    );
    expect(ddl.amount).toBe("REAL");
    expect(ddl.active).toBe("TEXT"); // eligible, but not requested — left alone
    const row0 = db.prepare(`SELECT active FROM "subs" WHERE id = 'row-0'`).get() as any;
    expect(row0.active).toBe("true"); // still the original cleaned string, untouched
  });

  it("apply reports a requested-but-ineligible column in skippedColumns instead of silently ignoring or converting it", async () => {
    await seedLegacyTable();
    process.env.CURF_LAKE_TYPED_COLUMNS = "true";

    const result = await applyTypedConversion({ tenantId: "t1", tableName: "subs", columns: ["amount", "plan"] });
    expect(result.convertedColumns).toEqual(["amount"]);
    expect(result.skippedColumns).toEqual(["plan"]);
    const ddl = db.prepare(`PRAGMA table_info("subs")`).all() as Array<{ name: string; type: string }>;
    expect(ddl.find((c) => c.name === "plan")?.type).toBe("TEXT");
  });

  it("refuses to run, leaving the table completely untouched, if a table already occupies the rebuild's temp name", async () => {
    await seedLegacyTable();
    process.env.CURF_LAKE_TYPED_COLUMNS = "true";
    db.exec(`CREATE TABLE "subs__phase_d_rebuild" (x TEXT)`);

    await expect(applyTypedConversion({ tenantId: "t1", tableName: "subs" })).rejects.toThrow(/already exists/);

    // Nothing about the real table changed — the guard fires before any
    // DDL mutation of "subs" itself.
    const ddl = db.prepare(`PRAGMA table_info("subs")`).all() as Array<{ name: string; type: string }>;
    for (const col of ddl) expect(col.type).toBe("TEXT");
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM "subs"`).get() as any).n;
    expect(count).toBe(11);
  });

  it("throws for a table that doesn't exist", async () => {
    freshDb();
    await expect(previewTypedConversion({ tenantId: "t1", tableName: "nope" })).rejects.toThrow(/not found/);
  });

  // ---- D4: Option C's promise — what the admin confirmed is what happens.
  describe("expectedLossy (the admin's confirmed counts)", () => {
    const tmpTableExists = () =>
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='subs__phase_d_rebuild'`).get() != null;

    it("reports lossy cells per converted column", async () => {
      await seedLegacyTable();
      process.env.CURF_LAKE_TYPED_COLUMNS = "true";
      const result = await applyTypedConversion({ tenantId: "t1", tableName: "subs" });
      expect(result.lossyByColumn).toEqual({ amount: 1, active: 1 });
      expect(result.lossyCells).toBe(2);
    });

    it("proceeds when the confirmed counts match exactly", async () => {
      await seedLegacyTable();
      process.env.CURF_LAKE_TYPED_COLUMNS = "true";
      const result = await applyTypedConversion({
        tenantId: "t1", tableName: "subs", expectedLossy: { amount: 1, active: 1 },
      });
      expect(result.convertedColumns.sort()).toEqual(["active", "amount"]);
    });

    it("aborts on drift, changing NOTHING — original DDL and rows intact, no temp table left behind", async () => {
      await seedLegacyTable();
      process.env.CURF_LAKE_TYPED_COLUMNS = "true";
      // The admin saw 0 lossy amounts; the data now has 1 (e.g. a bad row landed since).
      const err = await applyTypedConversion({
        tenantId: "t1", tableName: "subs", expectedLossy: { amount: 0, active: 1 },
      }).catch((e) => e);

      expect(isTypedConversionDriftError(err)).toBe(true);
      expect(err).toBeInstanceOf(TypedConversionDriftError);
      expect(err.expected).toEqual({ amount: 0, active: 1 });
      expect(err.actual).toEqual({ amount: 1, active: 1 });

      const ddl = db.prepare(`PRAGMA table_info("subs")`).all() as Array<{ name: string; type: string }>;
      for (const col of ddl) expect(col.type).toBe("TEXT");
      expect((db.prepare(`SELECT COUNT(*) AS n FROM "subs"`).get() as any).n).toBe(11);
      expect((db.prepare(`SELECT amount FROM "subs" WHERE id = 'row-10'`).get() as any).amount).toBe("not a number"); // raw text, un-nulled
      expect(tmpTableExists()).toBe(false);
    });

    it("treats a converting column the admin never confirmed as drift, not as 'unchecked'", async () => {
      await seedLegacyTable();
      process.env.CURF_LAKE_TYPED_COLUMNS = "true";
      const err = await applyTypedConversion({
        tenantId: "t1", tableName: "subs", expectedLossy: { amount: 1 }, // no entry for "active"
      }).catch((e) => e);
      expect(isTypedConversionDriftError(err)).toBe(true);
      expect(tmpTableExists()).toBe(false);
    });

    it("ignores confirmed counts for columns that aren't being converted", async () => {
      await seedLegacyTable();
      process.env.CURF_LAKE_TYPED_COLUMNS = "true";
      const result = await applyTypedConversion({
        tenantId: "t1", tableName: "subs", columns: ["amount"], expectedLossy: { amount: 1, active: 999 },
      });
      expect(result.convertedColumns).toEqual(["amount"]);
    });

    it("does no check at all when no counts are given — scripts/tests that never showed a preview aren't forced to invent one", async () => {
      await seedLegacyTable();
      process.env.CURF_LAKE_TYPED_COLUMNS = "true";
      await expect(applyTypedConversion({ tenantId: "t1", tableName: "subs" })).resolves.toMatchObject({ lossyCells: 2 });
    });
  });
});

describe("date order is stored, because cleaning destroys the evidence", () => {
  it("survives a round trip through ISO-only stored values", async () => {
    freshDb();
    await createOrReplaceTable({
      tenantId: "t1", tableName: "t",
      rows: [{ d: "25/12/2024" }], sourceKind: "upload",
    });
    // Nothing in the stored data still says "day-first" — every value is
    // ISO now. Only the recorded order can answer.
    const meta = (await getTable("t1", "t"))!;
    expect(meta.columns.find((c) => c.name === "d")).toMatchObject({ dateOrder: "dmy" });
  });

  it("keeps the bookkeeping key out of the public sourceConfig", async () => {
    freshDb();
    await createOrReplaceTable({
      tenantId: "t1", tableName: "t",
      rows: [{ d: "25/12/2024" }],
      sourceKind: "upload", sourceConfig: { filename: "x.csv" },
    });
    expect((await getTable("t1", "t"))!.sourceConfig).toEqual({ filename: "x.csv" });
  });
});

describe("rekeyDateOrder — the pure re-key behind rename/drop", () => {
  it("moves an entry to the new name, and drops it when the column is dropped", () => {
    expect(rekeyDateOrder({ __dateOrders: { d: "dmy", e: "mdy" }, filename: "x" }, "d", "issued"))
      .toEqual({ __dateOrders: { e: "mdy", issued: "dmy" }, filename: "x" });
    expect(rekeyDateOrder({ __dateOrders: { d: "dmy", e: "mdy" } }, "d", null))
      .toEqual({ __dateOrders: { e: "mdy" } });
  });

  it("removes the bookkeeping key entirely once nothing is left, keeping the rest of the config", () => {
    expect(rekeyDateOrder({ __dateOrders: { d: "dmy" }, filename: "x" }, "d", null)).toEqual({ filename: "x" });
    expect(rekeyDateOrder({ __dateOrders: { d: "dmy" } }, "d", null)).toEqual({});
  });

  it("returns the SAME reference when the column has no stored order, so callers can tell nothing changed", () => {
    const cfg = { __dateOrders: { e: "mdy" }, filename: "x" };
    expect(rekeyDateOrder(cfg, "d", "issued")).toBe(cfg);
    expect(rekeyDateOrder(undefined, "d", "issued")).toBeUndefined();
    expect(rekeyDateOrder(null, "d", null)).toBeNull();
  });
});

describe("renameColumn / dropColumn carry a date column's stored order with it (SQLite)", () => {
  const meta = () => JSON.parse((db.prepare(`SELECT source_config_json AS c FROM __lake_meta WHERE table_name = 'inv'`).get() as any).c ?? "{}");

  it("a renamed date column is still read the way the table was built", async () => {
    freshDb();
    await createOrReplaceTable({ tenantId: "t1", tableName: "inv", rows: [{ d: "25/12/2024", n: "a" }], sourceKind: "upload" });
    expect(meta().__dateOrders).toEqual({ d: "dmy" });

    await renameColumn({ tenantId: "t1", tableName: "inv", oldName: "d", newName: "issued" });
    expect(meta().__dateOrders).toEqual({ issued: "dmy" });

    await appendRows({ tenantId: "t1", tableName: "inv", rows: [{ issued: "03/04/2024", n: "b" }] });
    const stored = db.prepare(`SELECT n, issued FROM "inv" ORDER BY n`).all() as any[];
    // Day-first: 3 April. Without the stored order this batch is read on its
    // own and a lone ambiguous value can land as 4 March.
    expect(stored.map((r) => r.issued)).toEqual(["2024-12-25", "2024-04-03"]);
  });

  it("a dropped date column takes its order with it; the others keep theirs", async () => {
    freshDb();
    await createOrReplaceTable({ tenantId: "t1", tableName: "inv", rows: [{ d: "25/12/2024", e: "12/25/2024", n: "a" }], sourceKind: "upload" });
    expect(meta().__dateOrders).toEqual({ d: "dmy", e: "mdy" });
    await dropColumn({ tenantId: "t1", tableName: "inv", columnName: "d" });
    expect(meta().__dateOrders).toEqual({ e: "mdy" });
  });

  it("renaming a column with no stored order leaves the config alone", async () => {
    freshDb();
    await createOrReplaceTable({
      tenantId: "t1", tableName: "inv", rows: [{ d: "25/12/2024", n: "a" }], sourceKind: "upload", sourceConfig: { filename: "x.csv" },
    });
    const before = meta();
    await renameColumn({ tenantId: "t1", tableName: "inv", oldName: "n", newName: "name" });
    expect(meta()).toEqual(before);
  });

  it("addColumn / renameColumn / dropColumn are unchanged for the default engine otherwise", async () => {
    freshDb();
    await createOrReplaceTable({ tenantId: "t1", tableName: "inv", rows: [{ a: "1", b: "2" }], sourceKind: "upload" });
    await addColumn({ tenantId: "t1", tableName: "inv", columnName: "c", defaultValue: "x" });
    await renameColumn({ tenantId: "t1", tableName: "inv", oldName: "a", newName: "alpha" });
    await dropColumn({ tenantId: "t1", tableName: "inv", columnName: "b" });
    expect((db.prepare(`PRAGMA table_info("inv")`).all() as any[]).map((c) => c.name)).toEqual(["alpha", "c"]);
    expect(db.prepare(`SELECT alpha, c FROM "inv"`).get()).toEqual({ alpha: "1", c: "x" });
    await expect(renameColumn({ tenantId: "t1", tableName: "inv", oldName: "nope", newName: "z" })).rejects.toThrow(/not found/);
  });
});
