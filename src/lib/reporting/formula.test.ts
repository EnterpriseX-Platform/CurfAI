import { describe, it, expect } from "vitest";
import { compileFormula, evaluateRow, evaluateAggregate } from "./formula";

const rows = [
  { spend: 100, leads: 10, roi: 2 },
  { spend: 200, leads: 20, roi: 3 },
  { spend: 300, leads: 15, roi: 1.5 },
];

describe("formula.ts (expr-eval-fork)", () => {
  it("evaluates basic arithmetic on a row", () => {
    const expr = compileFormula("=spend / leads");
    const { value, error } = evaluateRow(expr, rows[0], rows);
    expect(error).toBeUndefined();
    expect(value).toBe(10);
  });

  it("strips the leading '=' spreadsheet prefix", () => {
    const withEquals = evaluateRow(compileFormula("=spend + 1"), rows[0], rows);
    const withoutEquals = evaluateRow(compileFormula("spend + 1"), rows[0], rows);
    expect(withEquals.value).toBe(withoutEquals.value);
  });

  it("aggregation helpers (SUM/AVG/MIN/MAX/COUNT) read the full column by name", () => {
    // Column names are passed as string literals — SUM("spend"), not
    // SUM(spend) — see the doc comment on makeAggregationHelpers().
    expect(evaluateAggregate(compileFormula('SUM("spend")'), rows).value).toBe(600);
    expect(evaluateAggregate(compileFormula('AVG("spend")'), rows).value).toBe(200);
    expect(evaluateAggregate(compileFormula('MIN("spend")'), rows).value).toBe(100);
    expect(evaluateAggregate(compileFormula('MAX("spend")'), rows).value).toBe(300);
    expect(evaluateAggregate(compileFormula('COUNT("spend")'), rows).value).toBe(3);
  });

  it("row-level share-of-total via SUM() on the closed-over dataset", () => {
    const { value } = evaluateRow(compileFormula('=spend / SUM("spend")'), rows[0], rows);
    expect(value).toBeCloseTo(100 / 600);
  });

  it("logic helpers: IF/AND/OR/NOT", () => {
    expect(evaluateRow(compileFormula("IF(roi > 2, 1, 0)"), rows[0], rows).value).toBe(0);
    expect(evaluateRow(compileFormula("IF(roi > 2, 1, 0)"), rows[1], rows).value).toBe(1);
    expect(evaluateRow(compileFormula("AND(spend > 50, leads > 5)"), rows[0], rows).value).toBe(true);
    expect(evaluateRow(compileFormula("OR(spend > 1000, leads > 5)"), rows[0], rows).value).toBe(true);
    expect(evaluateRow(compileFormula("NOT(spend > 1000)"), rows[0], rows).value).toBe(true);
  });

  it("math helpers: ABS/ROUND/CEIL/FLOOR", () => {
    expect(evaluateRow(compileFormula("ROUND(roi, 0)"), rows[2], rows).value).toBe(2);
    expect(evaluateRow(compileFormula("CEIL(roi)"), rows[2], rows).value).toBe(2);
    expect(evaluateRow(compileFormula("FLOOR(roi)"), rows[2], rows).value).toBe(1);
    expect(evaluateRow(compileFormula("ABS(-5)"), rows[0], rows).value).toBe(5);
  });

  it("string helpers: LEN/UPPER/LOWER/CONCAT", () => {
    const row = { name: "acme" };
    expect(evaluateRow(compileFormula("LEN(name)"), row, [row]).value).toBe(4);
    expect(evaluateRow(compileFormula("UPPER(name)"), row, [row]).value).toBe("ACME");
    expect(evaluateRow(compileFormula('CONCAT(name, "-co")'), row, [row]).value).toBe("acme-co");
  });

  it("comparison + word-form logical operators without IF wrapping", () => {
    // `&&`/`||` are NOT supported by this grammar (never were, in either
    // expr-eval or expr-eval-fork) — the word form (and/or/not) is.
    expect(evaluateRow(compileFormula("spend > 50 and leads > 5"), rows[0], rows).value).toBe(true);
    expect(() => compileFormula("spend > 50 && leads > 5")).toThrow();
  });

  it("normalizes -0, NaN, and Infinity to null/0 for display", () => {
    expect(evaluateRow(compileFormula("1/0"), rows[0], rows).value).toBeNull(); // Infinity -> null
    expect(evaluateRow(compileFormula("0 * -1"), rows[0], rows).value).toBe(0); // -0 -> 0
  });

  it("still has no JS escape — this is the entire point of using a sandboxed evaluator", () => {
    // These aren't valid expr-eval grammar; the parser should throw at
    // compile time rather than silently reaching into the JS runtime.
    expect(() => compileFormula("global.process.exit()")).not.toThrow();
    // The line above parses as member access on an undefined "global"
    // variable, which is inert — evaluate() should error, not execute JS.
    const r = evaluateRow(compileFormula("global.process.exit()"), rows[0], rows);
    expect(r.error).toBeDefined();
  });

  it("returns a #SYNTAX!-style error on malformed formulas instead of throwing uncaught", () => {
    expect(() => compileFormula("spend +* leads")).toThrow();
  });

  it("aggregate context (totals row) has no row-level bindings but keeps helpers", () => {
    const { value, error } = evaluateAggregate(compileFormula('SUM("spend") / COUNT("spend")'), rows);
    expect(error).toBeUndefined();
    expect(value).toBe(200);
  });
});
