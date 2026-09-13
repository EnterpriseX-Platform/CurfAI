import { describe, expect, it } from "vitest";
import { formatValue } from "./shared";

describe("formatValue percent", () => {
  it("scales a typical 0-1 fraction to a percent string", () => {
    expect(formatValue(0.348, "percent")).toBe("34.8%");
  });

  it("scales a fraction that crosses 1.0 (100%+) instead of treating it as already-scaled", () => {
    // A forecast upper bound of 101.7% stored as the standard 0-1 fraction (1.017).
    expect(formatValue(1.017, "percent")).toBe("101.7%");
  });

  it("scales small fractions near zero", () => {
    expect(formatValue(0.005, "percent")).toBe("0.5%");
  });

  it("scales negative fractions", () => {
    expect(formatValue(-0.12, "percent")).toBe("-12.0%");
  });
});

describe("formatValue compact option", () => {
  it("compacts a large number by default (axis/tooltip context — real clipping risk)", () => {
    expect(formatValue(61000, "number")).toBe("61K");
  });

  it("shows full precision when compact:false — a label with room to spread out", () => {
    expect(formatValue(61000, "number", undefined, { compact: false })).toBe("61,000");
  });

  it("compacts currency by default, full precision with compact:false", () => {
    expect(formatValue(61000, "currency", "USD")).toBe("$61K");
    expect(formatValue(61000, "currency", "USD", { compact: false })).toBe("$61,000");
  });

  it("leaves values under the 1000 threshold unaffected by compact:false either way", () => {
    expect(formatValue(42, "number")).toBe("42");
    expect(formatValue(42, "number", undefined, { compact: false })).toBe("42");
  });
});
