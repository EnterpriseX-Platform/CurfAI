import { describe, it, expect } from "vitest";
import {
  compileScalarFormula,
  evaluateScalar,
  SCALAR_FORMULA_MAX_LENGTH,
  SCALAR_FUNCTION_NAMES,
  SCALAR_RESERVED_NAMES,
} from "./formula";

const run = (src: string, vars: Record<string, number> = {}) => evaluateScalar(compileScalarFormula(src), vars);

describe("compileScalarFormula / evaluateScalar", () => {
  it("evaluates arithmetic over named numbers", () => {
    expect(run("npl * (1 + npl_shock / 100)", { npl: 1000, npl_shock: 20 })).toBeCloseTo(1200);
  });

  it("supports the logic and math helpers", () => {
    expect(run("IF(a > 1, ROUND(b, 1), 0)", { a: 2, b: 3.14159 })).toBe(3.1);
    expect(run("MAX(a, b) - MIN(a, b)", { a: 3, b: 10 })).toBe(7);
    expect(run("max(0, a)", { a: -5 })).toBe(0);
  });

  it("returns null rather than 0 for divide-by-zero and missing names", () => {
    expect(run("a / b", { a: 1, b: 0 })).toBeNull();
    expect(run("a + missing", { a: 1 })).toBeNull();
  });

  it("refuses member access", () => {
    expect(() => compileScalarFormula("a.b + 1")).toThrow();
  });

  it("strips the parser's non-deterministic and array functions", () => {
    for (const fn of ["random(1)", "map(a, b)", "fold(a, b, 0)", "fac(3)", "gamma(3)"]) {
      expect(run(fn, { a: 1, b: 2 }), fn).toBeNull();
    }
  });

  it("rejects empty and over-long formulas", () => {
    expect(() => compileScalarFormula("   ")).toThrow();
    expect(() => compileScalarFormula("a+".repeat(SCALAR_FORMULA_MAX_LENGTH))).toThrow(/longer than/);
  });

  it("reports called functions as symbols so references can be allow-listed", () => {
    const symbols = compileScalarFormula("IF(a > 1, b, c)").symbols();
    expect(symbols).toEqual(expect.arrayContaining(["IF", "a", "b", "c"]));
    expect(SCALAR_FUNCTION_NAMES.has("IF")).toBe(true);
    expect(SCALAR_FUNCTION_NAMES.has("random")).toBe(false);
  });

  it("lists the words a variable can't be named", () => {
    for (const w of ["round", "not", "and", "or", "e", "pi", "sqrt", "min", "random", "if", "sum", "length"]) {
      expect(SCALAR_RESERVED_NAMES.has(w), w).toBe(true);
    }
    expect(SCALAR_RESERVED_NAMES.has("npl_shock")).toBe(false);
  });
});
