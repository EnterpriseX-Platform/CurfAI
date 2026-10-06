import { describe, expect, it } from "vitest";
import { formatValue, seriesName, categoryAxisProps } from "./shared";

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

describe("seriesName", () => {
  it("reads a raw column key as a label", () => {
    expect(seriesName("revenue")).toBe("Revenue");
    expect(seriesName("net_revenue")).toBe("Net revenue");
    expect(seriesName("q3__target_")).toBe("Q3 target");
  });

  it("leaves a name someone already wrote alone", () => {
    for (const f of ["Revenue", "Gross margin %", "รายได้", "orderCount", "Q3 target"]) expect(seriesName(f)).toBe(f);
    // The chart's own name for a series wins over its column's.
    expect(seriesName("new_mrr", { seriesLabels: { new_mrr: "ลูกค้าใหม่" } })).toBe("ลูกค้าใหม่");
    expect(seriesName("churn", { seriesLabels: { new_mrr: "ลูกค้าใหม่" } })).toBe("Churn");
  });
});

describe("categoryAxisProps", () => {
  it("keeps recharts' defaults for a handful of bars", () => {
    expect(categoryAxisProps(6)).toEqual({});
  });
  it("shows and tilts every label once bars would crowd", () => {
    expect(categoryAxisProps(12)).toMatchObject({ interval: 0, angle: -35, textAnchor: "end" });
  });
});

describe("seriesTooltip", () => {
  const base = { data: [], xField: "x", cfg: {}, fmt: "percent", handleClick: () => {}, renderReferenceLines: () => null, renderAnnotations: () => null, renderForecastDecor: () => null } as any;
  it("names each series when there are several, so a Pareto's share and running share read apart", async () => {
    const { seriesTooltip } = await import("./shared");
    // Pet Lovers' Pareto read " : 10.1%" and " : 23.3%" (2026-10-03).
    expect(seriesTooltip({ ...base, yFields: ["share", "running"] })(0.101, "สัดส่วนจากทั้งหมด")).toEqual(["10.1%", "สัดส่วนจากทั้งหมด"]);
  });
  it("leaves one measure unnamed (the title names it) unless the name is the category", async () => {
    const { seriesTooltip } = await import("./shared");
    expect(seriesTooltip({ ...base, yFields: ["share"] })(0.5, "share")).toEqual(["50.0%", ""]);
    expect(seriesTooltip({ ...base, yFields: ["amount"] }, true)(0.5, "Cat food")).toEqual(["50.0%", "Cat food"]);
  });
});
