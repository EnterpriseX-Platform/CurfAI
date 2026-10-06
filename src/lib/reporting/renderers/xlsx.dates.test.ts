/**
 * Date columns in the Excel export are real dates (sortable, filterable),
 * keep their written wall-clock time, and read in Thai with Buddhist-era
 * years through Excel's own Thai Buddhist calendar code — verified against
 * Excel 16, where "[$-107041E]d mmm yyyy" shows 26 ก.ย. 2569.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("puppeteer", () => ({ default: { launch: vi.fn() } }));
const { excelDateFormats, excelDateValue } = await import("./xlsx");

describe("excelDateFormats", () => {
  it("keeps the ISO-style look for everyone but Thai readers", () => {
    expect(excelDateFormats()).toEqual({ date: "yyyy-mm-dd", datetime: "yyyy-mm-dd hh:mm" });
    expect(excelDateFormats({ locale: "en", era: "be" })).toEqual({ date: "yyyy-mm-dd", datetime: "yyyy-mm-dd hh:mm" });
  });
  it("uses Excel's Thai Buddhist calendar, or Thai Gregorian when chosen", () => {
    expect(excelDateFormats({ locale: "th" }).date).toBe("[$-107041E]d mmm yyyy");
    expect(excelDateFormats({ locale: "th", era: "be" }).datetime).toBe("[$-107041E]d mmm yyyy hh:mm");
    expect(excelDateFormats({ locale: "th", era: "ce" }).date).toBe("[$-41E]d mmm yyyy");
  });
});

describe("excelDateValue", () => {
  it("turns ISO text into a real date, wall clock kept", () => {
    expect((excelDateValue("2026-09-26") as Date).toISOString()).toBe("2026-09-26T00:00:00.000Z");
    expect((excelDateValue("2026-09-26T14:05:00") as Date).toISOString()).toBe("2026-09-26T14:05:00.000Z");
    expect((excelDateValue("2026-09-26 14:05") as Date).toISOString()).toBe("2026-09-26T14:05:00.000Z");
  });
  it("leaves empties empty and unparseable values as text", () => {
    expect(excelDateValue(null)).toBeNull();
    expect(excelDateValue("")).toBeNull();
    expect(excelDateValue("next Tuesday")).toBe("next Tuesday");
  });
});
