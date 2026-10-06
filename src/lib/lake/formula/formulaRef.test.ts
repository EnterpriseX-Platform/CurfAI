/**
 * formulaRef — how the editor, the AI writer and a rename write a column into
 * a formula — agrees with the parser for every kind of name. The AI writer's
 * own rule bracketed only names with spaces, so "unit-price" went to the
 * model bare and read back as unit − price (audit 2026-09-30, C6).
 */
import { describe, it, expect } from "vitest";
import { formulaRef } from "./parse";
import { compileFormula } from "./compile";
import { NEW_COLUMN_NAME_RE, assertNewColumnName } from "../columnName";

const names = ["revenue", "_tmp", "ยอดขาย", "unit-price", "unit cost", "Row ID", "true", "FALSE", "2024_total", "o'brien", "a]b"];

describe("formulaRef", () => {
  it("writes each name the way the parser reads back as that one column", () => {
    const columns = names.map((name) => ({ name, type: "number" }));
    for (const name of names) {
      const ref = formulaRef(name);
      if (name === "a]b") continue; // can't be written in brackets at all; the name rule keeps it from being created
      expect(compileFormula(ref, { columns, dialect: "sqlite" }).uses, name).toEqual([name]);
    }
  });

  it("leaves a plain name bare and brackets the rest", () => {
    expect(formulaRef("revenue")).toBe("revenue");
    expect(formulaRef("ยอดขาย")).toBe("ยอดขาย");
    expect(formulaRef("unit-price")).toBe("[unit-price]");
    expect(formulaRef("TRUE")).toBe("[TRUE]");
  });
});

describe("the new-column name rule", () => {
  it("is one rule for the engines and the editors", () => {
    expect(NEW_COLUMN_NAME_RE.test("profit_2026")).toBe(true);
    expect(NEW_COLUMN_NAME_RE.test("unit price")).toBe(false);
    expect(() => assertNewColumnName("2x")).toThrow("Column name must match");
    expect(() => assertNewColumnName("bad name", "rename")).toThrow("New column name must match");
  });
});
