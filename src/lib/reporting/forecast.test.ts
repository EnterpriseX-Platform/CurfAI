import { describe, expect, it } from "vitest";
import { linearFit, projectSeries, withForecast, exponentialSmoothingFit, projectSeriesETS, detectCadenceUnit } from "./forecast";

describe("linearFit", () => {
  it("returns null for fewer than 2 finite points", () => {
    expect(linearFit([])).toBeNull();
    expect(linearFit([5])).toBeNull();
    expect(linearFit([NaN, 5])).toBeNull();
  });

  it("fits a perfect line with zero residual", () => {
    const fit = linearFit([2, 4, 6, 8]);
    expect(fit).not.toBeNull();
    expect(fit!.slope).toBeCloseTo(2, 6);
    expect(fit!.intercept).toBeCloseTo(0, 6);
    expect(fit!.residualStd).toBeCloseTo(0, 6);
  });

  it("skips non-finite values when fitting", () => {
    const fit = linearFit([2, 4, NaN, 8]);
    // finite pairs are (1,2) (2,4) (4,8) — still a perfect y = 2x line
    expect(fit).not.toBeNull();
    expect(fit!.slope).toBeCloseTo(2, 6);
  });
});

describe("projectSeries", () => {
  const rows = [{ v: 10 }, { v: 20 }, { v: 30 }, { v: 40 }];

  it("returns empty array for zero/negative periods or empty input", () => {
    expect(projectSeries(rows, "v", 0)).toEqual([]);
    expect(projectSeries([], "v", 3)).toEqual([]);
  });

  it("projects a linear series forward with the correct slope", () => {
    const out = projectSeries(rows, "v", 2);
    expect(out).toHaveLength(2);
    expect(out[0].v).toBeCloseTo(50, 6);
    expect(out[1].v).toBeCloseTo(60, 6);
    for (const p of out) {
      expect(p.__forecast).toBe(true);
      expect(p.__upper).toBeGreaterThanOrEqual(p.v as number);
      expect(p.__lower).toBeLessThanOrEqual(p.v as number);
    }
  });

  it("labels projected x values with the default +k scheme", () => {
    const out = projectSeries(rows, "v", 2, { xField: "period" });
    expect(out[0].period).toBe("+1");
    expect(out[1].period).toBe("+2");
  });

  it("uses a custom xLabeler when provided", () => {
    const out = projectSeries(rows, "v", 2, {
      xField: "period",
      xLabeler: (_lv, k) => `step-${k}`,
    });
    expect(out[0].period).toBe("step-1");
    expect(out[1].period).toBe("step-2");
  });

  it("returns empty array for degenerate (single-point) input", () => {
    expect(projectSeries([{ v: 5 }], "v", 3)).toEqual([]);
  });

  it("clamps the point estimate and both bounds to zero when history was never negative", () => {
    // Perfect line through (100,80,60,40): slope -20, intercept 120.
    // Unclamped: k=3 -> -20, k=4 -> -40. History (all >= 0) says this
    // metric can't actually go negative, so both should floor at 0.
    const declining = [{ v: 100 }, { v: 80 }, { v: 60 }, { v: 40 }];
    const out = projectSeries(declining, "v", 4);
    expect(out[2].v).toBe(0); // would be -20 unclamped
    expect(out[3].v).toBe(0); // would be -40 unclamped
    expect(out[3].__lower).toBe(0);
    // Zero-residual fit -> band is 0, so __upper clamps to 0 too.
    expect(out[3].__upper).toBe(0);
  });

  it("does not clamp when the observed history already includes a negative value", () => {
    // Same shape/slope, shifted down so the series has been negative —
    // a margin/delta-style metric is allowed to keep going negative.
    const rows = [{ v: 10 }, { v: -10 }, { v: -30 }, { v: -50 }];
    const out = projectSeries(rows, "v", 1);
    expect(out[0].v).toBeCloseTo(-70, 6);
  });
});

describe("exponentialSmoothingFit", () => {
  it("returns null for fewer than 2 finite points", () => {
    expect(exponentialSmoothingFit([])).toBeNull();
    expect(exponentialSmoothingFit([5])).toBeNull();
    expect(exponentialSmoothingFit([NaN, 5])).toBeNull();
  });

  it("converges to the exact slope/level on a perfectly linear series (zero residual)", () => {
    // For y = 10x with no noise, both the level and one-step-ahead trend
    // estimate settle on the true slope — verifies the update isn't just
    // "close enough" but actually tracks a noise-free line exactly.
    const fit = exponentialSmoothingFit([10, 20, 30]);
    expect(fit).not.toBeNull();
    expect(fit!.level).toBeCloseTo(30, 6);
    expect(fit!.trend).toBeCloseTo(10, 6);
    expect(fit!.residualStd).toBeCloseTo(0, 6);
  });

  it("produces a positive residualStd when the series isn't perfectly linear", () => {
    const fit = exponentialSmoothingFit([10, 25, 28, 50]);
    expect(fit).not.toBeNull();
    expect(fit!.residualStd).toBeGreaterThan(0);
  });
});

describe("projectSeriesETS", () => {
  const linearRows = [{ v: 10 }, { v: 20 }, { v: 30 }];

  it("returns empty array for zero/negative periods or empty input", () => {
    expect(projectSeriesETS(linearRows, "v", 0)).toEqual([]);
    expect(projectSeriesETS([], "v", 3)).toEqual([]);
  });

  it("projects a perfectly linear series forward with a zero-width band", () => {
    const out = projectSeriesETS(linearRows, "v", 2);
    expect(out).toHaveLength(2);
    expect(out[0].v).toBeCloseTo(40, 6);
    expect(out[1].v).toBeCloseTo(50, 6);
    for (const p of out) {
      expect(p.__forecast).toBe(true);
      expect(p.__upper).toBeCloseTo(p.v as number, 6);
      expect(p.__lower).toBeCloseTo(p.v as number, 6);
    }
  });

  it("widens the band with the horizon (sqrt(k)) on a noisy series", () => {
    const noisy = [{ v: 10 }, { v: 25 }, { v: 28 }, { v: 50 }, { v: 48 }];
    const out = projectSeriesETS(noisy, "v", 3);
    const width = (p: (typeof out)[number]) => Number(p.__upper) - Number(p.__lower);
    expect(width(out[1])).toBeGreaterThan(width(out[0]));
    expect(width(out[2])).toBeGreaterThan(width(out[1]));
  });

  it("labels projected x values the same way projectSeries does", () => {
    const out = projectSeriesETS(linearRows, "v", 2, { xField: "period" });
    expect(out[0].period).toBe("+1");
    expect(out[1].period).toBe("+2");
  });

  it("returns empty array for degenerate (single-point) input", () => {
    expect(projectSeriesETS([{ v: 5 }], "v", 3)).toEqual([]);
  });

  it("clamps to zero when the observed history was never negative", () => {
    const declining = [{ v: 100 }, { v: 60 }, { v: 20 }]; // level=20, trend=-40 (zero residual)
    const out = projectSeriesETS(declining, "v", 2);
    expect(out[0].v).toBe(0); // would be -20 unclamped
    expect(out[1].v).toBe(0); // would be -60 unclamped
    expect(out[1].__lower).toBe(0);
    expect(out[1].__upper).toBe(0);
  });

  it("does not clamp when the observed history already includes a negative value", () => {
    const rows = [{ v: 20 }, { v: -20 }, { v: -60 }];
    const out = projectSeriesETS(rows, "v", 1);
    expect(out[0].v).toBeLessThan(0);
  });
});

describe("detectCadenceUnit", () => {
  it("returns \"point\" for fewer than 2 rows or non-string x-values", () => {
    expect(detectCadenceUnit([], "d")).toEqual({ unit: "point" });
    expect(detectCadenceUnit([{ d: "2026-01-01" }], "d")).toEqual({ unit: "point" });
    expect(detectCadenceUnit([{ d: 1 }, { d: 2 }], "d")).toEqual({ unit: "point" });
  });

  it("recognizes quarter, month, and year label patterns", () => {
    expect(detectCadenceUnit([{ d: "2025-Q1" }, { d: "2025-Q2" }], "d")).toEqual({ unit: "quarter" });
    expect(detectCadenceUnit([{ d: "2025-01" }, { d: "2025-02" }], "d")).toEqual({ unit: "month" });
    expect(detectCadenceUnit([{ d: "2024" }, { d: "2025" }], "d")).toEqual({ unit: "year" });
  });

  it("classifies an ISO-date gap by its real size, not a fixed guess", () => {
    // ~30 days apart — the exact case that used to be mislabeled as weekly.
    expect(detectCadenceUnit([{ d: "2026-03-14" }, { d: "2026-04-13" }], "d")).toEqual({ unit: "month", stepDays: 30 });
    expect(detectCadenceUnit([{ d: "2026-03-01" }, { d: "2026-03-08" }], "d")).toEqual({ unit: "week", stepDays: 7 });
    expect(detectCadenceUnit([{ d: "2026-03-01" }, { d: "2026-03-02" }], "d")).toEqual({ unit: "day", stepDays: 1 });
    expect(detectCadenceUnit([{ d: "2026-01-01" }, { d: "2026-04-01" }], "d")).toEqual({ unit: "quarter", stepDays: 90 });
    expect(detectCadenceUnit([{ d: "2024-01-01" }, { d: "2025-06-01" }], "d")).toEqual({ unit: "year", stepDays: 517 });
  });

  it("falls back to \"point\" for unrecognized label formats", () => {
    expect(detectCadenceUnit([{ d: "Alpha" }, { d: "Beta" }], "d")).toEqual({ unit: "point" });
  });
});

describe("withForecast", () => {
  it("appends projected rows after the original, unchanged", () => {
    const rows = [{ v: 10 }, { v: 20 }, { v: 30 }];
    const out = withForecast(rows, "v", 2);
    expect(out).toHaveLength(5);
    expect(out.slice(0, 3)).toEqual(rows);
    expect((out[3] as any).__forecast).toBe(true);
    expect((out[4] as any).__forecast).toBe(true);
  });
});
