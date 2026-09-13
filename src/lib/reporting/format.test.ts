/**
 * formatCell's "number" branch called formatNumber(value, 0) — a hardcoded
 * zero decimal places. Every fractional value in a report table was rounded
 * to a whole number on screen AND in the CSV and DOCX exports, so a 0.06
 * discount rate shipped to the customer as "0".
 */
import { describe, it, expect } from "vitest";
import { formatCell, formatDecimal, formatNumber } from "./format";

describe("formatCell — numeric precision", () => {
  it("keeps fractional values instead of rounding them away", () => {
    expect(formatCell(0.06, "number")).toBe("0.06");
    expect(formatCell(0.17, "number")).toBe("0.17");
    expect(formatCell(19.99, "number")).toBe("19.99");
  });

  it("still prints whole numbers cleanly, with separators", () => {
    expect(formatCell(3500, "number")).toBe("3,500");
    expect(formatCell(1104, "number")).toBe("1,104");
    expect(formatCell(0, "number")).toBe("0");
  });

  it("honours an explicit decimal count on the column", () => {
    expect(formatCell(1.005, "number", "2")).toBe("1.01");
    expect(formatCell(1234.5, "number", "0")).toBe("1,235");
  });

  it("handles negatives and non-numbers", () => {
    expect(formatCell(-0.25, "number")).toBe("-0.25");
    expect(formatCell(null, "number")).toBe("");
    expect(formatCell("abc", "number")).toBe("");
  });
});

describe("formatDecimal", () => {
  it("adapts to the value's own precision", () => {
    expect(formatDecimal(10)).toBe("10");
    expect(formatDecimal(10.5)).toBe("10.5");
    expect(formatDecimal(1234567.891)).toBe("1,234,567.891");
  });

  it("caps runaway precision", () => {
    expect(formatDecimal(1 / 3)).toBe("0.3333");
  });
});

describe("formatNumber", () => {
  it("still defaults to whole numbers for its existing callers", () => {
    expect(formatNumber(1234.9)).toBe("1,235");
    expect(formatNumber(1234.56, 2)).toBe("1,234.56");
  });
});
