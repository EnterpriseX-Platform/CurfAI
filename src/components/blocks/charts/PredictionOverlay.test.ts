import { describe, expect, it } from "vitest";
import { computeForecastBoundary, computeForecastRangeSummary, buildForecastFields } from "./PredictionOverlay";
import { withForecast } from "@/lib/reporting/forecast";
import type { ForecastConfig } from "@/lib/reporting/schema";

const forecast: ForecastConfig = { method: "linear", periods: 2, showBands: true };

describe("computeForecastBoundary", () => {
  const rows = [
    { period: "Jan", v: 10 },
    { period: "Feb", v: 20 },
    { period: "Mar", v: 30 },
    { period: "Apr", v: 40 },
  ];
  const withProjection = withForecast(rows, "v", 2, { xField: "period" });

  it("returns undefined boundary/end when there is no forecast config", () => {
    expect(computeForecastBoundary(rows, undefined, "period")).toEqual({ boundary: undefined, end: undefined });
  });

  it("returns undefined when the dataset is too short to contain a projection", () => {
    const tooShort = rows.slice(0, 2); // length (2) <= forecast.periods (2)
    expect(computeForecastBoundary(tooShort, forecast, "period")).toEqual({ boundary: undefined, end: undefined });
  });

  it("finds the last historical label and the last projected label", () => {
    const { boundary, end } = computeForecastBoundary(withProjection, forecast, "period");
    expect(boundary).toBe("Apr");
    expect(end).toBe("+2");
  });
});

describe("computeForecastRangeSummary", () => {
  it("returns null when the last row isn't a forecast row", () => {
    expect(computeForecastRangeSummary([{ v: 10 }, { v: 20 }], "v")).toBeNull();
  });

  it("returns null when the point forecast is 0 (percent delta undefined)", () => {
    const data = [{ v: 10 }, { v: 0, __forecast: true, __upper: 5, __lower: -5 }];
    expect(computeForecastRangeSummary(data, "v")).toBeNull();
  });

  it("computes symmetric upper/lower percent deltas off the point forecast", () => {
    const data = [{ v: 10 }, { v: 100, __forecast: true, __upper: 122, __lower: 92 }];
    const out = computeForecastRangeSummary(data, "v");
    expect(out).toEqual({ value: 100, upper: 122, lower: 92, upperDeltaPct: 22, lowerDeltaPct: 8 });
  });

  it("handles a negative point forecast using its magnitude for the percent base", () => {
    const data = [{ v: -50, __forecast: true, __upper: -40, __lower: -60 }];
    const out = computeForecastRangeSummary(data, "v");
    expect(out?.upperDeltaPct).toBeCloseTo(20); // (-40 - -50) / 50 * 100
    expect(out?.lowerDeltaPct).toBeCloseTo(20); // (-50 - -60) / 50 * 100
  });
});

describe("buildForecastFields", () => {
  it("returns rows unchanged when nothing is forecasted", () => {
    const data = [{ v: 1 }, { v: 2 }];
    expect(buildForecastFields(data, "v")).toEqual(data);
  });

  it("keeps the row count and order identical to the input (critical for a categorical x-axis)", () => {
    const rows = [{ v: 10 }, { v: 20 }, { v: 30 }];
    const withProjection = withForecast(rows, "v", 2) as Array<Record<string, unknown>>;
    const out = buildForecastFields(withProjection, "v");
    expect(out).toHaveLength(withProjection.length);
  });

  it("nulls `v` on forecast rows and fills `v__predicted` from the boundary row onward", () => {
    const rows = [{ v: 10 }, { v: 20 }, { v: 30 }];
    const withProjection = withForecast(rows, "v", 2) as Array<Record<string, unknown>>;
    const out = buildForecastFields(withProjection, "v");
    // historical rows before the boundary: untouched, no predicted field
    expect(out[0]).toEqual({ v: 10 });
    expect(out[1]).toEqual({ v: 20 });
    // boundary row (last actual point): keeps v, gains v__predicted (same value)
    expect(out[2].v).toBe(30);
    expect(out[2].v__predicted).toBe(30);
    // forecast rows: v is undefined, v__predicted carries the projected value
    expect(out[3].v).toBeUndefined();
    expect(out[3].v__predicted).toBe((withProjection[3] as any).v);
    expect(out[4].v).toBeUndefined();
    expect(out[4].v__predicted).toBe((withProjection[4] as any).v);
  });

  it("handles an all-forecast dataset (no preceding actual row)", () => {
    const data = [{ __forecast: true, v: 1 }, { __forecast: true, v: 2 }];
    const out = buildForecastFields(data, "v");
    expect(out[0]).toEqual({ __forecast: true, v: undefined, v__predicted: 1 });
    expect(out[1]).toEqual({ __forecast: true, v: undefined, v__predicted: 2 });
  });
});
