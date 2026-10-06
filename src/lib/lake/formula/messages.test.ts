import { describe, it, expect } from "vitest";
import { FORMULA_ERRORS, FORMULA_FUNCTION_DOCS, formulaErrorText } from "./messages";
import { FORMULA_FUNCTIONS, compileFormula } from "./compile";
import { FormulaError } from "./parse";

const holes = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort().join(",");

describe("formula error messages", () => {
  it("say the same thing in every language: each keeps the English one's placeholders", () => {
    const bad = Object.entries(FORMULA_ERRORS).filter(([, e]) => holes(e.th) !== holes(e.en) || holes(e.zh) !== holes(e.en) || !e.th.trim() || !e.zh.trim());
    expect(bad.map(([k]) => k)).toEqual([]);
  });

  it("every function the editor lists has its description in Thai and Chinese", () => {
    for (const loc of ["th", "zh"] as const) expect(Object.keys(FORMULA_FUNCTION_DOCS[loc]).sort()).toEqual(Object.keys(FORMULA_FUNCTIONS).sort());
  });

  it("an error from the compiler reads in the reader's language, types included", () => {
    const columns = [{ name: "store", type: "text" }, { name: "qty", type: "number" }];
    const errOf = (f: string) => { try { compileFormula(f, { columns, dialect: "sqlite" }); } catch (e) { return e as FormulaError; } throw new Error("compiled"); };
    const e = errOf('IF(qty > 5, "bulk", 1)');
    expect(e.message).toBe("IF's two answers must be the same kind — here one is text and the other a number");
    expect(formulaErrorText("th", e)).toBe("ผลลัพธ์ทั้งสองของ IF ต้องเป็นชนิดเดียวกัน — ตอนนี้อันหนึ่งเป็นข้อความ อีกอันเป็นตัวเลข");
    expect(formulaErrorText("zh", errOf("qyt * 2"))).toBe("没有名为 qyt 的列 — 你是指 qty 吗？");
  });

  it("an error it doesn't know (a newer server) falls back to the English it was sent", () => {
    expect(formulaErrorText("th", { key: "from_the_future", message: "Something new" })).toBe("Something new");
  });
});
