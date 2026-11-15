import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { compileFormula, storageType, quoteIdent, MAX_SQL_LENGTH, type Dialect, type FormulaColumn } from "./compile";
import { FormulaError } from "./parse";
import { CASES, cols, norm, rows } from "./compile.fixtures";

const sqlite = (dialect: Dialect = "sqlite") => (src: string, extra: Partial<Parameters<typeof compileFormula>[1]> = {}) =>
  compileFormula(src, { columns: cols, dialect, ...extra });
const c = sqlite();

function errorOf(src: string, extra: Partial<Parameters<typeof compileFormula>[1]> = {}): FormulaError {
  try { c(src, extra); } catch (e) { if (e instanceof FormulaError) return e; throw e; }
  throw new Error(`expected "${src}" to fail`);
}

describe("compileFormula — what a formula may say", () => {
  it("reads number columns as numbers, and says which columns it uses", () => {
    const r = c("revenue * margin_pct");
    expect(r.type).toBe("number");
    expect(r.uses).toEqual(["revenue", "margin_pct"]);
    expect(r.sql).toContain('CAST("revenue" AS REAL)');
  });
  it("types what it gives", () => {
    expect(c('IF(qty >= 5, "bulk", "single")').type).toBe("text");
    expect(c("qty > 5").type).toBe("boolean");
    expect(c("YEAR(order_date)").type).toBe("number");
    expect(c('store & " · " & channel').type).toBe("text");
    expect(c("order_date").type).toBe("date");
  });
  it("names in [brackets] may have spaces; names match regardless of case", () => {
    expect(c("[unit cost] * QTY").uses).toEqual(["unit cost", "qty"]);
  });
  it("a column that doesn't exist, with the one that was probably meant", () => {
    const e = errorOf("reveune * 2");
    expect(e.message).toBe("There's no column called reveune — did you mean revenue?");
    expect(e.at).toBe(0);
    expect(errorOf("qty + margin").message).toMatch(/no column called margin/);
  });
  it("a function that doesn't exist, and one that changes on its own", () => {
    expect(errorOf("ROUNDUP(revenue, 1)").message).toBe("There's no function called ROUNDUP — did you mean ROUND?");
    expect(errorOf("DAYS(TODAY(), order_date)").message).toMatch(/TODAY\(\) changes on its own/);
    expect(errorOf("revenue * RAND()").code).toBe("changing_function");
  });
  it("the wrong number of values", () => {
    expect(errorOf("IF(qty > 1, 1)").message).toBe("IF takes 3 values: IF(test, then, else)");
    expect(errorOf("ROUND()").message).toBe("ROUND takes 1 or 2 values: ROUND(number, digits)");
  });
  it("types that don't fit say why, and where", () => {
    expect(errorOf("store * 2").message).toMatch(/store is a text column, so it can't be used as a number/);
    expect(errorOf('"x" + qty').message).toMatch(/Text can't be used with \+ — use & to join texts/);
    expect(errorOf("shipped_date - order_date").message).toMatch(/use DAYS\(end_date, start_date\)/);
    expect(errorOf('IF(qty > 5, 1, "few")').message).toMatch(/IF's two answers must be the same kind/);
    expect(errorOf("store = 5").message).toBe("Can't compare text with a number");
    expect(errorOf("IF(qty, 1, 2)").message).toBe("qty is a number, not a yes/no test — compare it, like qty > 0");
    expect(errorOf("IF(qty + 1, 1, 2)").message).toMatch(/gives a number, but a yes\/no test is needed/);
  });
  it("dates are written YYYY-MM-DD", () => {
    expect(c('order_date >= "2024-10-01"').type).toBe("boolean");
    expect(errorOf('order_date >= "1/10/2024"').message).toMatch(/write dates as "YYYY-MM-DD"/);
  });
  it("syntax errors point at the problem", () => {
    const at = (s: string) => errorOf(s).at;
    expect(errorOf("ROUND(revenue, 2").message).toBe("Missing a closing )");
    expect(at('"open')).toBe(0);
    expect(errorOf("revenue 2").message).toMatch(/"2" is in an unexpected place/);
    expect(at("qty # 2")).toBe(4);
    expect(errorOf("").code).toBe("empty");
    expect(errorOf("x".repeat(1001)).code).toBe("too_long");
    expect(errorOf("(".repeat(60) + "1" + ")".repeat(60)).code).toBe("too_deep");
  });
  it("a formula column can't use itself, directly or in a circle", () => {
    const withFx: FormulaColumn[] = [...cols, { name: "profit", type: "number", formula: "revenue * margin_pct" }, { name: "profit_x2", type: "number", formula: "profit * 2" }];
    expect(compileFormula("profit + 1", { columns: withFx, dialect: "sqlite" }).uses).toEqual(["profit"]);
    expect(() => compileFormula("profit + 1", { columns: withFx, dialect: "sqlite", self: "profit" })).toThrow(/can't use its own column/);
    expect(() => compileFormula("profit_x2 + 1", { columns: withFx, dialect: "sqlite", self: "profit" })).toThrow(/go round in a circle/);
  });
});

describe("compileFormula — the SQL it writes stays bounded (audit 2026-09-30, S6)", () => {
  const nine = "qty, unit_price, revenue, margin_pct, [unit cost], qty, unit_price, revenue, margin_pct";
  it("a real formula — MIN over nine columns — is well inside the limit on both engines", () => {
    for (const d of ["sqlite", "duckdb"] as const) {
      expect(sqlite(d)(`MIN(${nine})`).sql.length).toBeLessThan(MAX_SQL_LENGTH / 2);
    }
  });
  it("nesting that would grow the SQL exponentially is refused, quickly, at the node that crosses the limit", () => {
    // Each level writes its inner MIN out twice (COALESCE falls back to the other value): 12 levels is ~4,000× the SQL of one.
    const nested = Array.from({ length: 12 }).reduce<string>((s) => `MIN(${s}, qty)`, "qty");
    const t0 = Date.now();
    const e = (() => { try { c(nested); } catch (err) { return err as FormulaError; } throw new Error("expected too_complex"); })();
    expect(e).toBeInstanceOf(FormulaError);
    expect(e.code).toBe("too_complex");
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("compileFormula — nothing typed becomes SQL of its own", () => {
  it("text is always a quoted literal; a quote in it can't end it", () => {
    const r = c('store & "\'); DROP TABLE orders; --"');
    expect(r.sql).toContain("'''); DROP TABLE orders; --'");
  });
  it("a column name with a double quote is quoted, not closed", () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
    const r = compileFormula('[a"b] + 1', { columns: [{ name: 'a"b', type: "number" }], dialect: "sqlite" });
    expect(r.sql).toContain('"a""b"');
  });
  it("anything but the language is refused before any SQL is built", () => {
    expect(() => c("revenue; DELETE FROM orders")).toThrow(FormulaError);
    expect(() => c("revenue -- comment")).toThrow(FormulaError);
    expect(() => c("(SELECT 1)")).toThrow(FormulaError);
    expect(() => c("SELECT")).toThrow(/no column called SELECT/);
  });
});

// ---- The same formula, the same answers (compile.fixtures.ts; DuckDB in compile.duckdb.test.ts) ----

describe("compileFormula — SQLite (the lake's default engine) as a stored column", () => {
  const db = new Database(":memory:");
  beforeAll(() => {
    db.exec(`CREATE TABLE orders (${cols.map((x) => `${quoteIdent(x.name)} TEXT`).join(", ")})`);
    const ins = db.prepare(`INSERT INTO orders (${cols.map((x) => quoteIdent(x.name)).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
    for (const r of rows) ins.run(...cols.map((x) => r[x.name] ?? null));
  });
  afterAll(() => db.close());

  CASES.forEach(([src, want], i) => it(src, () => {
    const r = compileFormula(src, { columns: cols, dialect: "sqlite" });
    // The same statement the lake will run: a live (generated) column, added to a table that already has rows.
    db.exec(`ALTER TABLE orders ADD COLUMN "f${i}" ${storageType(r.type, "sqlite")} GENERATED ALWAYS AS (${r.sql}) VIRTUAL`);
    const got = (db.prepare(`SELECT "f${i}" AS v FROM orders ORDER BY order_id`).all() as Array<{ v: unknown }>).map((x) => norm(x.v, r.type));
    expect(got).toEqual(want.map((v) => norm(v, r.type)));
  }));

  it("rows added later get the formula too, and writes that list their columns still work", () => {
    db.prepare(`INSERT INTO orders (order_id, qty, unit_price, revenue, margin_pct) VALUES ('ORD-4', '2', '10', '20', '0.25')`).run();
    const v = db.prepare(`SELECT "f0" AS v FROM orders WHERE order_id = 'ORD-4'`).get() as { v: number };
    expect(v.v).toBe(5);
  });
});


import { renameColumnInFormula } from "./parse";

describe("renameColumnInFormula", () => {
  it("renames the column wherever it's read, whatever the case it was written in", () => {
    expect(renameColumnInFormula("Revenue * margin_pct + ROUND(revenue, 2)", "revenue", "net_revenue"))
      .toBe("net_revenue * margin_pct + ROUND(net_revenue, 2)");
  });
  it("leaves function names, text in quotes and other columns alone", () => {
    expect(renameColumnInFormula('IF(left > 0, "left", LEFT(name, 1))', "left", "l2")).toBe('IF(l2 > 0, "left", LEFT(name, 1))');
    expect(renameColumnInFormula("revenue_2 * 2", "revenue", "x")).toBe("revenue_2 * 2");
  });
  it("brackets a new name that needs it; still renames in a formula that doesn't check out", () => {
    expect(renameColumnInFormula("qty * 2", "qty", "จำนวน ชิ้น")).toBe("[จำนวน ชิ้น] * 2");
    expect(renameColumnInFormula("qty * (", "qty", "n")).toBe("n * (");
    expect(renameColumnInFormula('qty & "open', "qty", "n")).toBe('qty & "open');
  });
});
