import { describe, it, expect } from "vitest";
import { computeKpiValue, pickKpiCompare, kpiDelta, pickKpiPlan, kpiVsPlan } from "./kpi";

describe("computeKpiValue", () => {
  const rows = [{ v: "10", prior: 8 }, { v: 20 }, { v: "x" }, { v: null }, { v: 30 }];

  it("takes row 0 when there is no aggregate", () => {
    expect(computeKpiValue({ valueField: "v" }, rows)).toBe(10);
  });

  it("is NaN for no rows, a missing field, or a non-numeric row 0", () => {
    expect(Number.isNaN(computeKpiValue({ valueField: "v" }, []))).toBe(true);
    expect(Number.isNaN(computeKpiValue({ valueField: "nope" }, rows))).toBe(true);
    expect(Number.isNaN(computeKpiValue({ valueField: "v" }, [{ v: "abc" }]))).toBe(true);
  });

  it("aggregates over every numeric row, ignoring non-numeric ones", () => {
    expect(computeKpiValue({ valueField: "v", aggregate: "sum" }, rows)).toBe(60);
    expect(computeKpiValue({ valueField: "v", aggregate: "avg" }, rows)).toBe(20);
    expect(computeKpiValue({ valueField: "v", aggregate: "min" }, rows)).toBe(10);
    expect(computeKpiValue({ valueField: "v", aggregate: "max" }, rows)).toBe(30);
  });

  it("count ignores the value field entirely", () => {
    expect(computeKpiValue({ valueField: "nope", aggregate: "count" }, rows)).toBe(5);
  });

  it("aggregate over only non-numeric rows is NaN, not 0", () => {
    expect(Number.isNaN(computeKpiValue({ valueField: "v", aggregate: "sum" }, [{ v: "a" }]))).toBe(true);
  });
});

describe("pickKpiCompare / kpiDelta", () => {
  it("reads the comparison from row 0 and computes a relative delta", () => {
    const rows = [{ v: 11, prior: 10 }];
    expect(pickKpiCompare(rows, "prior")).toBe(10);
    expect(kpiDelta(11, pickKpiCompare(rows, "prior"))).toBeCloseTo(0.1);
  });

  it("is undefined without a field, without rows, or against zero", () => {
    expect(pickKpiCompare([{ v: 1 }], undefined)).toBeUndefined();
    expect(pickKpiCompare([], "prior")).toBeUndefined();
    expect(kpiDelta(5, 0)).toBeUndefined();
    expect(kpiDelta(NaN, 3)).toBeUndefined();
  });
});

describe("pickKpiPlan / kpiVsPlan", () => {
  it("reads the plan from a column before a fixed number", () => {
    expect(pickKpiPlan([{ revenue: 102, plan: 110 }], { plan: 90, planField: "plan" })).toBe(110);
    expect(pickKpiPlan([{ revenue: 102 }], { plan: 90 })).toBe(90);
    expect(pickKpiPlan([{ revenue: 102 }], {})).toBeUndefined();
    expect(pickKpiPlan([{ plan: 5 }, { plan: 7 }], { planField: "plan", aggregate: "sum" })).toBe(12);
  });
  it("says behind or ahead by the metric's good direction", () => {
    expect(kpiVsPlan(96, 100, "currency", "up")).toEqual({ state: "behind", text: "4.0%" });
    expect(kpiVsPlan(104, 100, "currency", null)).toEqual({ state: "ahead", text: "4.0%" });
    // A return rate under plan is ahead, and a rate moves in points.
    expect(kpiVsPlan(0.013, 0.015, "percent", "down")).toEqual({ state: "ahead", text: "0.2 pts" });
    expect(kpiVsPlan(0.018, 0.015, "percent", "down")).toEqual({ state: "behind", text: "0.3 pts" });
  });
  it("calls a near miss on plan, and has nothing to say without a plan", () => {
    expect(kpiVsPlan(100.2, 100, "number", "up")!.state).toBe("on");
    expect(kpiVsPlan(100, undefined, "number", "up")).toBeUndefined();
    expect(kpiVsPlan(5, 0, "number", "up")).toBeUndefined();
  });
});
