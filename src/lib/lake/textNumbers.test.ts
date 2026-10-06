import { describe, it, expect } from "vitest";
import { textNumberError, textNumberMisuse } from "./textNumbers";

const cols = ["fiscal_month", "budget_amount", "progress_pct"];

describe("textNumberMisuse", () => {
  it("flags ordering by a text-stored number column", () => {
    expect(textNumberMisuse("SELECT * FROM expense_monthly ORDER BY fiscal_month", cols)).toEqual(["fiscal_month"]);
    expect(textNumberMisuse("SELECT * FROM p ORDER BY p.budget_amount DESC LIMIT 5", cols)).toEqual(["budget_amount"]);
    expect(textNumberMisuse(`SELECT * FROM p ORDER BY "budget_amount" DESC NULLS LAST`, cols)).toEqual(["budget_amount"]);
    // A window's ORDER BY misorders the running total the same way.
    expect(textNumberMisuse("SELECT SUM(x) OVER (PARTITION BY y ORDER BY fiscal_month) FROM t", cols)).toEqual(["fiscal_month"]);
  });

  it("flags order comparisons and MIN/MAX", () => {
    expect(textNumberMisuse("SELECT * FROM t WHERE fiscal_month <= 6", cols)).toEqual(["fiscal_month"]);
    expect(textNumberMisuse("SELECT * FROM t WHERE 500000 < budget_amount", cols)).toEqual(["budget_amount"]);
    expect(textNumberMisuse("SELECT * FROM t WHERE progress_pct BETWEEN 1 AND 99", cols)).toEqual(["progress_pct"]);
    expect(textNumberMisuse("SELECT MAX(budget_amount) FROM t", cols)).toEqual(["budget_amount"]);
  });

  it("leaves CAST, SUM/AVG, equality and the query's own names alone", () => {
    expect(textNumberMisuse("SELECT * FROM t WHERE CAST(fiscal_month AS INTEGER) <= 6 ORDER BY CAST(budget_amount AS DOUBLE) DESC", cols)).toEqual([]);
    expect(textNumberMisuse("SELECT SUM(budget_amount) AS total, AVG(progress_pct) FROM t WHERE fiscal_month = 6 AND progress_pct <> 0", cols)).toEqual([]);
    // Ordered by the aggregate the query named after the column: a number, not the text column.
    expect(textNumberMisuse("SELECT plan, SUM(budget_amount) AS budget_amount FROM t GROUP BY plan ORDER BY budget_amount DESC", cols)).toEqual([]);
    // A CTE that casts the month once, then orders by it.
    expect(textNumberMisuse("WITH m AS (SELECT CAST(fiscal_month AS INTEGER) AS fiscal_month FROM t) SELECT * FROM m ORDER BY fiscal_month", cols)).toEqual([]);
  });

  it("doesn't mistake a longer name or a string for the column", () => {
    expect(textNumberMisuse("SELECT * FROM t ORDER BY fiscal_month_name", cols)).toEqual([]);
    expect(textNumberMisuse("SELECT * FROM t WHERE note < 'fiscal_month > 3'", cols)).toEqual([]);
  });
});

describe("textNumberError", () => {
  it("names the columns and the fix", () => {
    const e = textNumberError(["fiscal_month"]);
    expect(e).toContain(`"fiscal_month"`);
    expect(e).toContain("CAST(fiscal_month AS DOUBLE)");
  });
});
