/**
 * formatCell's "number" branch called formatNumber(value, 0) — a hardcoded
 * zero decimal places. Every fractional value in a report table was rounded
 * to a whole number on screen AND in the CSV and DOCX exports, so a 0.06
 * discount rate shipped to the customer as "0".
 */
import { describe, it, expect } from "vitest";
import { formatCell, formatDecimal, formatNumber, formatCurrency, formatPercent, aggregate, buddhistYearPattern, thaiDateLabel, dateValueLabel, isMonthStartSeries, deltaDir, kpiChange, signedChange } from "./format";

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

describe("formatCell — dates", () => {
  it("leaves English and Chinese readers exactly as before", () => {
    expect(formatCell("2026-09-26", "date")).toBe("2026-09-26");
    expect(formatCell("2026-09-26T14:05:00", "datetime")).toBe("2026-09-26 14:05");
    expect(formatCell("2026-09-26", "date", undefined, undefined, { locale: "en", era: "be" })).toBe("2026-09-26");
    expect(formatCell("2026-09-26", "date", "dd/MM/yyyy", undefined, { locale: "zh" })).toBe("26/09/2026");
  });
  it("gives Thai readers Buddhist-era years by default, Gregorian when they (or the report) chose it", () => {
    expect(formatCell("2026-09-26", "date", undefined, undefined, { locale: "th" })).toBe("26 ก.ย. 2569");
    expect(formatCell("2026-09-26", "date", undefined, undefined, { locale: "th", era: "ce" })).toBe("26 ก.ย. 2026");
    expect(formatCell("2026-09-26T14:05:00", "datetime", undefined, undefined, { locale: "th" })).toBe("26 ก.ย. 2569 14:05");
  });
  it("keeps an author's pattern and only changes its year", () => {
    expect(formatCell("2026-09-26", "date", "dd/MM/yyyy", undefined, { locale: "th" })).toBe("26/09/2569");
    expect(formatCell("2026-09-26", "date", "d MMM yy", undefined, { locale: "th" })).toBe("26 ก.ย. 69");
    expect(formatCell("2026-09-26", "date", "dd/MM/yyyy", undefined, { locale: "th", era: "ce" })).toBe("26/09/2026");
  });
  it("shows what it can't parse as-is, and nothing for empty", () => {
    expect(formatCell("not a date", "date", undefined, undefined, { locale: "th" })).toBe("not a date");
    expect(formatCell(null, "date", undefined, undefined, { locale: "th" })).toBe("");
  });
});

describe("buddhistYearPattern", () => {
  it("replaces year tokens outside quoted literals only", () => {
    expect(buddhistYearPattern("yyyy-MM-dd", 2026)).toBe("'2569'-MM-dd");
    expect(buddhistYearPattern("d/M/yy", 2026)).toBe("d/M/'69'");
    expect(buddhistYearPattern("'year' yyyy", 2026)).toBe("'year' '2569'");
  });
});

describe("thaiDateLabel", () => {
  it("formats ISO days, months and datetimes for a Thai reader", () => {
    expect(thaiDateLabel("2026-09-26", { locale: "th" })).toBe("26 ก.ย. 2569");
    expect(thaiDateLabel("2026-09-26", { locale: "th" }, "axis")).toBe("26 ก.ย. 69");
    expect(thaiDateLabel("2026-09", { locale: "th" })).toBe("ก.ย. 2569");
    expect(thaiDateLabel("2026-09-26T14:05:00", { locale: "th", era: "ce" })).toBe("26 ก.ย. 2026 14:05");
  });
  it("returns null for other readers and for anything that isn't an ISO date", () => {
    expect(thaiDateLabel("2026-09-26", { locale: "en" })).toBeNull();
    expect(thaiDateLabel("North", { locale: "th" })).toBeNull();
    expect(thaiDateLabel(2026, { locale: "th" })).toBeNull();
    expect(thaiDateLabel("2026", { locale: "th" })).toBeNull();
  });
});

describe("dateValueLabel / isMonthStartSeries", () => {
  it("reads ISO dates in every reader's language, a month as a month", () => {
    // Siam Tech's monthly MRR showed "2025-09-01" on every tick to an English reader (2026-10-03).
    expect(dateValueLabel("2025-09-01", { locale: "en" }, "axis", true)).toBe("Sep 25");
    expect(dateValueLabel("2025-09-01", { locale: "en" }, "full", true)).toBe("Sep 2025");
    expect(dateValueLabel("2025-09-14", { locale: "en" }, "axis")).toBe("14 Sep 25");
    expect(dateValueLabel("2025-09", { locale: "en" })).toBe("Sep 2025");
    expect(dateValueLabel("2025-09-01", { locale: "th" }, "axis", true)).toBe("ก.ย. 68");
    expect(dateValueLabel("2025-09-14", { locale: "th" }, "axis")).toBe("14 ก.ย. 68");
    expect(dateValueLabel("2025-09-01", { locale: "zh" }, "axis", true)).toBe("25年9月");
  });
  it("leaves anything that isn't a date to its caller, and a time to Thai readers only", () => {
    expect(dateValueLabel("North", { locale: "en" })).toBeNull();
    expect(dateValueLabel(2025, { locale: "en" })).toBeNull();
    expect(dateValueLabel("2025-09-14T10:00:00", { locale: "en" })).toBeNull();
    expect(dateValueLabel("2025-09-14T10:00:00", { locale: "th", era: "ce" })).toBe("14 ก.ย. 2025 10:00");
  });
  it("calls a run of first-of-month dates months, but not a lone one or a mixed run", () => {
    expect(isMonthStartSeries(["2025-09-01", "2025-10-01", null])).toBe(true);
    expect(isMonthStartSeries(["2025-09", "2025-10"])).toBe(true);
    expect(isMonthStartSeries(["2025-09"])).toBe(true);
    expect(isMonthStartSeries(["2025-09-01"])).toBe(false);
    expect(isMonthStartSeries(["2025-09-01", "2025-09-02"])).toBe(false);
    expect(isMonthStartSeries(["SMB", "2025-09-01"])).toBe(false);
    expect(isMonthStartSeries([])).toBe(false);
  });
});

describe("deltaDir", () => {
  it("reads a rounding wobble as flat, not as a rise", () => {
    expect(deltaDir(0)).toBe("flat");
    expect(deltaDir(0.0004)).toBe("flat");
    expect(deltaDir(-0.0009)).toBe("flat");
    expect(deltaDir(null)).toBe("flat");
  });
  it("reads a real move", () => {
    expect(deltaDir(0.061)).toBe("up");
    expect(deltaDir(-0.02)).toBe("down");
  });
});

describe("signedChange", () => {
  it("marks a predicted rise with +, leaves a fall's own sign", () => {
    expect(signedChange(28_000, "$28K")).toBe("+$28K");
    expect(signedChange(-0.011, "-1.1%")).toBe("-1.1%");
    expect(signedChange(null, "—")).toBe("—");
  });
});

describe("kpiChange", () => {
  it("moves a rate in points, not relative percent", () => {
    expect(kpiChange({ format: "percent", currentValue: 0.018, previousValue: 0.010, deltaPct: 0.8 })).toEqual({ dir: "up", text: "0.8 pts" });
  });
  it("calls a rate that didn't visibly move flat", () => {
    expect(kpiChange({ format: "percent", currentValue: 0.018, previousValue: 0.01786, deltaPct: 0.008 })).toEqual({ dir: "flat", text: "0.0 pts" });
  });
  it("keeps relative change for everything else", () => {
    expect(kpiChange({ format: "currency", currentValue: 102.5, previousValue: 99.7, deltaPct: 0.028 })).toEqual({ dir: "up", text: "2.8%" });
    expect(kpiChange({ format: "number", deltaPct: null })).toBeNull();
  });
  it("uses the reader's unit word", () => {
    expect(kpiChange({ format: "percent", currentValue: 0.029, previousValue: 0.041 }, "จุด")!.text).toBe("1.2 จุด");
  });
});

describe("absent is not zero", () => {
  // A promotion's margin is unknown when the POS file has no cost column;
  // it rendered as "฿0.00", and the column's total as "฿0.00" too.
  it("leaves a missing amount, count or rate blank", () => {
    for (const v of [null, undefined, ""]) {
      expect(formatCurrency(v, "THB")).toBe("");
      expect(formatNumber(v)).toBe("");
      expect(formatPercent(v)).toBe("");
      expect(formatCell(v, "currency", undefined, "THB")).toBe("");
    }
    expect(formatCurrency(0, "THB")).toBe("฿0.00");
  });

  it("totals only the values that are there — none at all totals nothing", () => {
    expect(aggregate([{ m: null }, { m: null }], "m", "sum")).toBeNull();
    expect(aggregate([{ m: null }, { m: 5 }, { m: "" }], "m", "avg")).toBe(5);
  });
});

describe("thaiMoney — baht in Thai units for a Thai reader", () => {
  it("reads like a Thai budget document, long and short", async () => {
    const { thaiMoney, readsThaiMoney, formatMetricCompact } = await import("./format");
    expect(thaiMoney(20_350_830_000, false)).toBe("20.35 พันล้านบาท");
    expect(thaiMoney(20_350_830_000, true)).toBe("20.4\u00a0พันล.");
    expect(thaiMoney(-368_000_000, true)).toBe("−368\u00a0ล.");
    expect(thaiMoney(5_690_000, false)).toBe("5.7 ล้านบาท");
    expect(thaiMoney(5_400, true)).toBe("5.4\u00a0พัน");
    expect(thaiMoney(5_400, false)).toBe("5,400 บาท");
    // Only baht, only for a Thai reader.
    expect(readsThaiMoney("THB", "th")).toBe(true);
    expect(readsThaiMoney("THB", "en")).toBe(false);
    expect(readsThaiMoney("USD", "th")).toBe(false);
    expect(formatMetricCompact(9e9, "currency", "THB", "th")).toBe("9\u00a0พันล.");
    expect(formatMetricCompact(9e9, "currency", "THB", "en")).toBe("฿9B");
  });
});
