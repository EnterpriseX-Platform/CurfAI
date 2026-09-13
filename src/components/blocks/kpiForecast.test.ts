import { describe, expect, it } from "vitest";
import { buildSparkSeries } from "./KpiBlock";
import { projectSeries } from "@/lib/reporting/forecast";
import type { ForecastConfig } from "@/lib/reporting/schema";

const forecast: ForecastConfig = { method: "linear", periods: 3, showBands: true };

describe("buildSparkSeries", () => {
  it("returns the series unchanged when there is no forecast config", () => {
    const values = [1, 2, 3];
    expect(buildSparkSeries(values, undefined)).toEqual({ values, forecastCount: 0 });
  });

  it("returns the series unchanged when there are fewer than 2 points", () => {
    expect(buildSparkSeries([5], forecast)).toEqual({ values: [5], forecastCount: 0 });
    expect(buildSparkSeries([], forecast)).toEqual({ values: [], forecastCount: 0 });
  });

  it("appends exactly `periods` projected values matching forecast.ts's own math", () => {
    const values = [10, 20, 30, 40];
    const { values: out, forecastCount } = buildSparkSeries(values, forecast);
    expect(forecastCount).toBe(3);
    expect(out).toHaveLength(7);
    expect(out.slice(0, 4)).toEqual(values);

    // Cross-check against forecast.ts directly — the KPI sparkline must
    // agree with the chart-level forecast for the same input, or a user
    // would see two different "predicted" numbers for the same metric.
    const expected = projectSeries(values.map((v) => ({ v })), "v", 3).map((p) => Number(p.v));
    expect(out.slice(4)).toEqual(expected);
  });
});
