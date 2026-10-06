/**
 * Formula columns on the SQLite lake, end to end through tables.ts — every
 * path that writes to or rebuilds a table keeps them. ee.lake is absent, so
 * each call takes its SQLite path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

let db: InstanceType<typeof Database>;
vi.mock("./storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./storage")>();
  return { ...actual, openLake: () => db };
});
vi.mock("@/ee", () => ({ ee: {} }));

const {
  createOrReplaceTable, appendRows, upsertLakeRowsByKey, getTable, addColumn, renameColumn, dropColumn,
  retypeColumn, setFormulaColumn, applyTypedConversion,
} = await import("./tables");
const { readFormulas } = await import("./formulaColumns");

const T = "t1";
const orders = [
  { order_id: "ORD-1", store: "Lakeshore", qty: "3", revenue: "96", margin_pct: "0.4" },
  { order_id: "ORD-2", store: "Old Town", qty: "6", revenue: "1014", margin_pct: "0.5" },
];
const rowsOf = () => db.prepare(`SELECT * FROM "orders" ORDER BY order_id`).all() as Array<Record<string, unknown>>;
// Rounded: 96 * 0.4 is 38.400000000000006 in floating point, on any engine.
const valuesOf = (col: string) => rowsOf().map((r) => (typeof r[col] === "number" ? Math.round((r[col] as number) * 1e6) / 1e6 : r[col]));

beforeEach(async () => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE __lake_meta (table_name TEXT PRIMARY KEY, source_kind TEXT NOT NULL, source_config_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), row_count INTEGER NOT NULL DEFAULT 0)`);
  await createOrReplaceTable({ tenantId: T, tableName: "orders", rows: orders, sourceKind: "upload" });
});

describe("setFormulaColumn — a live column the engine works out", () => {
  it("adds it, computes it for every row, and lists it with its formula and type", async () => {
    expect(await setFormulaColumn({ tenantId: T, tableName: "orders", columnName: "profit", formula: "revenue * margin_pct" }))
      .toEqual({ type: "number", uses: ["revenue", "margin_pct"] });
    expect(valuesOf("profit")).toEqual([38.4, 507]);
    const col = (await getTable(T, "orders"))!.columns.find((c) => c.name === "profit");
    expect(col).toEqual({ name: "profit", type: "number", formula: "revenue * margin_pct" });
  });

  it("rows that arrive later have it too", async () => {
    await setFormulaColumn({ tenantId: T, tableName: "orders", columnName: "profit", formula: "revenue * margin_pct" });
    await appendRows({ tenantId: T, tableName: "orders", rows: [{ order_id: "ORD-3", store: "Westway", qty: "1", revenue: "10", margin_pct: "0.5" }] });
    expect(valuesOf("profit")).toEqual([38.4, 507, 5]);
  });

  it("a value arriving under a formula column's name is left to the formula, not stored or re-added", async () => {
    await setFormulaColumn({ tenantId: T, tableName: "orders", columnName: "profit", formula: "revenue * margin_pct" });
    const r = await appendRows({ tenantId: T, tableName: "orders", rows: [{ order_id: "ORD-3", store: "W", qty: "1", revenue: "10", margin_pct: "0.5", profit: "999" }] });
    expect(r.newColumns).toEqual([]);
    expect(valuesOf("profit")[2]).toBe(5);
  });

  it("upserts by key work around it", async () => {
    await setFormulaColumn({ tenantId: T, tableName: "orders", columnName: "profit", formula: "revenue * margin_pct" });
    await upsertLakeRowsByKey({ tenantId: T, tableName: "orders", keyColumn: "order_id", rows: [{ order_id: "ORD-2", store: "Old Town", qty: "6", revenue: "2000", margin_pct: "0.5", profit: "1" }] });
    expect(valuesOf("profit")).toEqual([38.4, 1000]);
  });

  it("checks the formula against the table, and refuses a name that's taken", async () => {
    await expect(setFormulaColumn({ tenantId: T, tableName: "orders", columnName: "x", formula: "reveune * 2" })).rejects.toThrow(/did you mean revenue/);
    await expect(setFormulaColumn({ tenantId: T, tableName: "orders", columnName: "revenue", formula: "qty * 2" })).rejects.toThrow(/already exists/);
    await expect(setFormulaColumn({ tenantId: T, tableName: "orders", columnName: "bad name", formula: "qty" })).rejects.toThrow(/must match/);
  });

  it("changing a formula re-adds the formula columns built on it, with their new values", async () => {
    await setFormulaColumn({ tenantId: T, tableName: "orders", columnName: "profit", formula: "revenue * margin_pct" });
    await setFormulaColumn({ tenantId: T, tableName: "orders", columnName: "profit_x2", formula: "profit * 2" });
    await setFormulaColumn({ tenantId: T, tableName: "orders", columnName: "profit", formula: "revenue - 6", replace: true });
    expect(valuesOf("profit")).toEqual([90, 1008]);
    expect(valuesOf("profit_x2")).toEqual([180, 2016]);
    expect(Object.keys(readFormulas(db, "orders")).sort()).toEqual(["profit", "profit_x2"]);
  });

  it("a change that would break a formula built on it is refused, and nothing changes", async () => {
    await setFormulaColumn({ tenantId: T, tableName: "orders", columnName: "profit", formula: "revenue * margin_pct" });
    await setFormulaColumn({ tenantId: T, tableName: "orders", columnName: "profit_x2", formula: "profit * 2" });
    await expect(setFormulaColumn({ tenantId: T, tableName: "orders", columnName: "profit", formula: 'store & "!"', replace: true }))
      .rejects.toThrow(/profit_x2 uses profit and would stop working/);
    expect(valuesOf("profit_x2")).toEqual([76.8, 1014]);
    expect(readFormulas(db, "orders").profit!.formula).toBe("revenue * margin_pct");
  });
});

describe("the column changes around formulas", () => {
  beforeEach(async () => { await setFormulaColumn({ tenantId: T, tableName: "orders", columnName: "profit", formula: "revenue * margin_pct" }); });

  it("renaming a column a formula reads rewrites the formula, and it keeps working", async () => {
    await renameColumn({ tenantId: T, tableName: "orders", oldName: "revenue", newName: "net_revenue" });
    expect(readFormulas(db, "orders").profit!.formula).toBe("net_revenue * margin_pct");
    expect(valuesOf("profit")).toEqual([38.4, 507]);
  });

  it("a formula column can be renamed", async () => {
    await renameColumn({ tenantId: T, tableName: "orders", oldName: "profit", newName: "gross_profit" });
    expect(Object.keys(readFormulas(db, "orders"))).toEqual(["gross_profit"]);
    expect(valuesOf("gross_profit")).toEqual([38.4, 507]);
  });

  it("a column a formula reads can't be dropped — the error names the formula", async () => {
    await expect(dropColumn({ tenantId: T, tableName: "orders", columnName: "margin_pct" }))
      .rejects.toThrow("margin_pct is used by the formula column profit — change or remove it first");
  });

  it("a formula column can be dropped, and its formula goes with it", async () => {
    await dropColumn({ tenantId: T, tableName: "orders", columnName: "profit" });
    expect(readFormulas(db, "orders")).toEqual({});
    expect(Object.keys(rowsOf()[0]!)).not.toContain("profit");
  });

  it("a formula column's type can't be changed by hand", async () => {
    await expect(retypeColumn({ tenantId: T, tableName: "orders", columnName: "profit", type: "text" })).rejects.toThrow(/its type is what its formula gives/);
  });

  it("a new column can't take a formula column's name", async () => {
    await expect(addColumn({ tenantId: T, tableName: "orders", columnName: "PROFIT" })).rejects.toThrow(/already exists/);
  });
});

describe("rebuilds keep formula columns", () => {
  beforeEach(async () => { await setFormulaColumn({ tenantId: T, tableName: "orders", columnName: "profit", formula: "revenue * margin_pct" }); });

  it("a re-upload keeps them, computed on the new rows", async () => {
    const r = await createOrReplaceTable({ tenantId: T, tableName: "orders", rows: [{ order_id: "ORD-9", store: "X", qty: "2", revenue: "50", margin_pct: "0.2" }], sourceKind: "upload" });
    expect(valuesOf("profit")).toEqual([10]);
    expect(r.columns.at(-1)).toEqual({ name: "profit", type: "number", formula: "revenue * margin_pct" });
    expect(r.droppedFormulas).toBeUndefined();
  });

  it("a re-upload without a column a formula read drops that formula, and says why", async () => {
    const r = await createOrReplaceTable({ tenantId: T, tableName: "orders", rows: [{ order_id: "ORD-9", store: "X", revenue: "50" }], sourceKind: "upload" });
    expect(r.droppedFormulas).toEqual([{ name: "profit", reason: "There's no column called margin_pct" }]);
    expect(readFormulas(db, "orders")).toEqual({});
  });

  it("a re-upload whose data has a column of the formula's name keeps the data's", async () => {
    const r = await createOrReplaceTable({ tenantId: T, tableName: "orders", rows: [{ order_id: "ORD-9", revenue: "5", margin_pct: "0.2", profit: "real" }], sourceKind: "upload" });
    expect(r.droppedFormulas).toEqual([{ name: "profit", reason: "the new data has a column with this name" }]);
    expect(valuesOf("profit")).toEqual(["real"]);
  });

  it("a typed conversion keeps them", async () => {
    const flag = process.env.CURF_LAKE_TYPED_COLUMNS;
    process.env.CURF_LAKE_TYPED_COLUMNS = "true";
    try {
      await applyTypedConversion({ tenantId: T, tableName: "orders" });
      expect(valuesOf("profit")).toEqual([38.4, 507]);
      expect(readFormulas(db, "orders").profit).toEqual({ formula: "revenue * margin_pct", type: "number" });
    } finally {
      if (flag === undefined) delete process.env.CURF_LAKE_TYPED_COLUMNS; else process.env.CURF_LAKE_TYPED_COLUMNS = flag;
    }
  });

  it("the table's settings don't show the formulas as bookkeeping — the columns carry them", async () => {
    expect((await getTable(T, "orders"))!.sourceConfig ?? {}).not.toHaveProperty("__formulas");
  });
});

describe("addColumn — a blank column of a type", () => {
  it("cleans the default to the type, and refuses one that isn't", async () => {
    await addColumn({ tenantId: T, tableName: "orders", columnName: "target", type: "number", defaultValue: "1,299" });
    expect(valuesOf("target")).toEqual(["1299", "1299"]);
    await expect(addColumn({ tenantId: T, tableName: "orders", columnName: "due", type: "date", defaultValue: "soon" })).rejects.toThrow(/isn't a date/);
  });
});

afterEach(() => db.close());
