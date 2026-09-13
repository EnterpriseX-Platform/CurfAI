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
 */
import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";

let db: InstanceType<typeof Database>;

vi.mock("./storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./storage")>();
  return { ...actual, openLake: () => db };
});

import {
  inferColumns, createOrReplaceTable, cleanRowsForColumns, retypeColumn,
  appendRows, getTable, qIdent,
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
  it("a currency-formatted column sums correctly through SQLite's own CAST", () => {
    freshDb();
    createOrReplaceTable({
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

  it("a thousands-separated column sums correctly", () => {
    freshDb();
    createOrReplaceTable({
      tenantId: "t1", tableName: "t",
      rows: [{ units: "1,234" }, { units: "5,678" }],
      sourceKind: "upload",
    });
    const row = db.prepare(`SELECT SUM(CAST(${qIdent("units")} AS REAL)) AS total FROM "t"`).get() as any;
    expect(row.total).toBe(6912);
  });

  it("a stray N/A becomes a real NULL, not the literal text 'N/A'", () => {
    freshDb();
    createOrReplaceTable({
      tenantId: "t1", tableName: "t",
      rows: [{ amount: "100" }, { amount: "N/A" }, { amount: "300" }],
      sourceKind: "upload",
    });
    const rows = db.prepare(`SELECT ${qIdent("amount")} AS v FROM "t" ORDER BY rowid`).all() as any[];
    expect(rows.map((r) => r.v)).toEqual(["100", null, "300"]);
  });

  it("a ZIP-code-shaped column keeps its leading zero on disk", () => {
    freshDb();
    createOrReplaceTable({
      tenantId: "t1", tableName: "t",
      rows: [{ zip: "00501" }],
      sourceKind: "upload",
    });
    const row = db.prepare(`SELECT ${qIdent("zip")} AS v FROM "t"`).get() as any;
    expect(row.v).toBe("00501");
  });

  it("a slash date is stored as canonical ISO, not the original text", () => {
    freshDb();
    createOrReplaceTable({
      tenantId: "t1", tableName: "t",
      rows: [{ d: "01/15/2024" }],
      sourceKind: "upload",
    });
    const row = db.prepare(`SELECT ${qIdent("d")} AS v FROM "t"`).get() as any;
    expect(row.v).toBe("2024-01-15");
  });

  it("columnTypeOverrides wins over inference — and changes how the value is cleaned", () => {
    freshDb();
    // "$1,234" alone would infer + clean as number ("1234"). Forcing text
    // via override must both persist "text" as the type AND skip the
    // numeric cleaning, leaving the original formatting intact — proving
    // the override drives the cleaning pass, not just the schema label.
    const { columns } = createOrReplaceTable({
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
});

describe("appendRows — the same cleaning applies to a scheduled pull's batch", () => {
  it("cleans a currency-formatted append batch", () => {
    freshDb();
    createOrReplaceTable({
      tenantId: "t1", tableName: "t", rows: [{ price: "100" }], sourceKind: "upload",
    });
    appendRows({ tenantId: "t1", tableName: "t", rows: [{ price: "$250.00" }] });
    const row = db.prepare(`SELECT SUM(CAST(${qIdent("price")} AS REAL)) AS total FROM "t"`).get() as any;
    expect(row.total).toBe(350);
  });
});

describe("retypeColumn — recovery for a mistyped or pre-existing column", () => {
  it("cleans every cell to the new type and reports how many changed", () => {
    freshDb();
    createOrReplaceTable({
      tenantId: "t1", tableName: "t",
      rows: [{ v: "$100" }, { v: "$200" }, { v: "not a number" }],
      sourceKind: "upload",
      columnTypeOverrides: { v: "text" }, // simulate a table stored raw, pre-feature
    });
    const result = retypeColumn({ tenantId: "t1", tableName: "t", columnName: "v", type: "number" });
    expect(result.updated).toBe(2); // the two currency values clean
    expect(result.unchanged).toBe(1); // "not a number" can't clean, stays as-is

    const rows = db.prepare(`SELECT ${qIdent("v")} AS x FROM "t" ORDER BY rowid`).all() as any[];
    expect(rows.map((r) => r.x)).toEqual(["100", "200", "not a number"]);
  });

  it("cleans a stale null-token left over from before this feature existed", () => {
    freshDb();
    createOrReplaceTable({
      tenantId: "t1", tableName: "t", rows: [{ v: "100" }], sourceKind: "upload",
    });
    // createOrReplaceTable now null-tokens "N/A" on ingest regardless of
    // column type, so a legacy pre-feature table is the only realistic way
    // to see raw "N/A" on disk — simulate it by writing directly, as a
    // table created before this cleaning shipped would actually look.
    db.prepare(`UPDATE "t" SET ${qIdent("v")} = 'N/A' WHERE rowid = 1`).run();
    expect((db.prepare(`SELECT ${qIdent("v")} AS x FROM "t"`).get() as any).x).toBe("N/A");
    retypeColumn({ tenantId: "t1", tableName: "t", columnName: "v", type: "number" });
    expect((db.prepare(`SELECT ${qIdent("v")} AS x FROM "t"`).get() as any).x).toBeNull();
  });

  it("throws for a column that doesn't exist", () => {
    freshDb();
    createOrReplaceTable({ tenantId: "t1", tableName: "t", rows: [{ a: "1" }], sourceKind: "upload" });
    expect(() => retypeColumn({ tenantId: "t1", tableName: "t", columnName: "nope", type: "number" }))
      .toThrow(/not found/);
  });

  it("retyping to text is a safe no-op recovery for a mangled numeric column", () => {
    freshDb();
    createOrReplaceTable({
      tenantId: "t1", tableName: "t", rows: [{ v: "42" }], sourceKind: "upload",
    });
    const result = retypeColumn({ tenantId: "t1", tableName: "t", columnName: "v", type: "text" });
    expect(result.unchanged).toBe(1);
  });
});

describe("date order end-to-end — a day-first column survives ingest", () => {
  it("types a day-first column as date and stores real ISO dates", () => {
    freshDb();
    // Under the old month-first-only parser every one of these but 03/04
    // failed to parse, so the column lost its vote and landed as text.
    createOrReplaceTable({
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

  it("retype to date reads the column's own values to pick the order", () => {
    freshDb();
    // Land raw text first, then retype — the pre-existing-table recovery path.
    createOrReplaceTable({
      tenantId: "t1", tableName: "legacy",
      rows: [{ d: "x" }], sourceKind: "upload",
    });
    const ins = db.prepare(`INSERT INTO "legacy" (${qIdent("d")}) VALUES (?)`);
    db.prepare(`DELETE FROM "legacy"`).run();
    for (const v of ["03/04/2024", "28/02/2024"]) ins.run(v);

    retypeColumn({ tenantId: "t1", tableName: "legacy", columnName: "d", type: "date" });
    const stored = db.prepare(`SELECT ${qIdent("d")} AS v FROM "legacy"`).all() as any[];
    // 28 proves day-first, so 03/04 must read as 3 April — not 4 March.
    expect(stored.map((r) => r.v)).toEqual(["2024-04-03", "2024-02-28"]);
  });
});

describe("appendRows / upsert — the table's type wins over the batch's", () => {
  it("does not retype an established text column because one batch looks numeric", () => {
    freshDb();
    // Reference codes: text, and some of them have leading zeros.
    createOrReplaceTable({
      tenantId: "t1", tableName: "refs",
      rows: [{ code: "00501" }, { code: "A-22" }, { code: "00777" }],
      sourceKind: "webhook",
    });
    // A later batch happens to be all plainly-numeric-looking with commas.
    appendRows({ tenantId: "t1", tableName: "refs", rows: [{ code: "1,234" }] });
    const stored = db.prepare(`SELECT ${qIdent("code")} AS v FROM "refs"`).all() as any[];
    // Batch-local inference would have called this column number and
    // stripped the comma, leaving "1234" among untouched "A-22"/"00501".
    expect(stored.map((r) => r.v)).toEqual(["00501", "A-22", "00777", "1,234"]);
  });

  it("keeps the table's established day/month order when a batch can't prove one", () => {
    freshDb();
    createOrReplaceTable({
      tenantId: "t1", tableName: "events",
      rows: [{ at: "25/12/2024" }, { at: "13/04/2024" }],  // proves day-first
      sourceKind: "webhook",
    });
    // This batch alone is ambiguous and would have defaulted to month-first.
    appendRows({ tenantId: "t1", tableName: "events", rows: [{ at: "03/04/2024" }] });
    const stored = db.prepare(`SELECT ${qIdent("at")} AS v FROM "events"`).all() as any[];
    expect(stored[2].v).toBe("2024-04-03");
  });

  it("still lets the batch decide a column the table doesn't have yet", () => {
    freshDb();
    createOrReplaceTable({
      tenantId: "t1", tableName: "widgets",
      rows: [{ sku: "A1" }], sourceKind: "webhook",
    });
    appendRows({ tenantId: "t1", tableName: "widgets", rows: [{ sku: "B2", price: "$1,299.00" }] });
    const stored = db.prepare(`SELECT ${qIdent("price")} AS v FROM "widgets" WHERE ${qIdent("sku")} = 'B2'`).get() as any;
    expect(stored.v).toBe("1299");
  });
});

describe("date order is stored, because cleaning destroys the evidence", () => {
  it("survives a round trip through ISO-only stored values", () => {
    freshDb();
    createOrReplaceTable({
      tenantId: "t1", tableName: "t",
      rows: [{ d: "25/12/2024" }], sourceKind: "upload",
    });
    // Nothing in the stored data still says "day-first" — every value is
    // ISO now. Only the recorded order can answer.
    const meta = getTable("t1", "t")!;
    expect(meta.columns.find((c) => c.name === "d")).toMatchObject({ dateOrder: "dmy" });
  });

  it("keeps the bookkeeping key out of the public sourceConfig", () => {
    freshDb();
    createOrReplaceTable({
      tenantId: "t1", tableName: "t",
      rows: [{ d: "25/12/2024" }],
      sourceKind: "upload", sourceConfig: { filename: "x.csv" },
    });
    expect(getTable("t1", "t")!.sourceConfig).toEqual({ filename: "x.csv" });
  });
});
