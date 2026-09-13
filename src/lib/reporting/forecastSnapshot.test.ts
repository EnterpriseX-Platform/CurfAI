import { describe, expect, it } from "vitest";
import { buildSnapshotCandidates } from "./forecastSnapshot";

describe("buildSnapshotCandidates", () => {
  it("returns nothing when there are no forecast rows", () => {
    const rows = [{ d: "2026-01-01", v: 10 }, { d: "2026-02-01", v: 20 }];
    expect(buildSnapshotCandidates(rows, "d", "v")).toEqual([]);
  });

  it("extracts a candidate from an ISO-date forecast row", () => {
    const rows = [
      { d: "2026-08-11", v: 100 },
      { d: "2026-09-08", v: 110, __forecast: true, __upper: 120, __lower: 100 },
    ];
    const out = buildSnapshotCandidates(rows, "d", "v");
    expect(out).toHaveLength(1);
    expect(out[0].targetLabel).toBe("2026-09-08");
    expect(out[0].targetDate.toISOString().slice(0, 10)).toBe("2026-09-08");
    expect(out[0].predictedValue).toBe(110);
    expect(out[0].upperBound).toBe(120);
    expect(out[0].lowerBound).toBe(100);
  });

  it("skips forecast rows whose x-label isn't a real ISO date (quarter/month/+k labels)", () => {
    const rows = [
      { d: "2025-Q4", v: 10, __forecast: true, __upper: 12, __lower: 8 },
      { d: "2025-04", v: 20, __forecast: true, __upper: 22, __lower: 18 },
      { d: "+1", v: 30, __forecast: true, __upper: 32, __lower: 28 },
    ];
    expect(buildSnapshotCandidates(rows, "d", "v")).toEqual([]);
  });

  it("skips a forecast row with a non-finite predicted value or bounds", () => {
    const rows = [
      { d: "2026-09-08", v: NaN, __forecast: true, __upper: 10, __lower: 5 },
      { d: "2026-09-15", v: 10, __forecast: true, __upper: undefined, __lower: 5 },
    ];
    expect(buildSnapshotCandidates(rows, "d", "v")).toEqual([]);
  });

  it("only extracts rows actually flagged __forecast, even if the label looks like a date", () => {
    const rows = [{ d: "2026-09-08", v: 10 }]; // no __forecast flag — this is real historical data
    expect(buildSnapshotCandidates(rows, "d", "v")).toEqual([]);
  });

  it("handles multiple forecast rows in one call", () => {
    const rows = [
      { d: "2026-08-11", v: 100 },
      { d: "2026-09-08", v: 110, __forecast: true, __upper: 120, __lower: 100 },
      { d: "2026-10-06", v: 115, __forecast: true, __upper: 130, __lower: 100 },
    ];
    const out = buildSnapshotCandidates(rows, "d", "v");
    expect(out.map((c) => c.targetLabel)).toEqual(["2026-09-08", "2026-10-06"]);
  });
});
