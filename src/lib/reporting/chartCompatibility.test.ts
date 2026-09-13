import { describe, it, expect } from "vitest";
import { profileColumns, checkChartTypeEligibility, rankChartTypes, CHART_TYPE_META } from "./chartCompatibility";

describe("profileColumns", () => {
  it("classifies numeric, date, categorical, and high-cardinality text columns", () => {
    const rows = [
      { region: "North", revenue: 100, date: "2026-01-01", note: "a" },
      { region: "South", revenue: 200, date: "2026-01-02", note: "b" },
      { region: "East", revenue: 150, date: "2026-01-03", note: "c" },
    ];
    const p = profileColumns(rows);
    expect(p.region.kind).toBe("categorical");
    expect(p.revenue.kind).toBe("numeric");
    expect(p.date.kind).toBe("date");
  });

  it("parks a column with no non-null values as text with hasData: false", () => {
    const rows = [{ x: null }, { x: null }];
    const p = profileColumns(rows);
    expect(p.x).toEqual({ name: "x", kind: "text", hasData: false, distinctCount: 0 });
  });

  it("falls back to text once distinct values exceed the categorical threshold", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: `row-${i}` }));
    const p = profileColumns(rows);
    expect(p.id.kind).toBe("text");
  });
});

describe("checkChartTypeEligibility", () => {
  const profiles = profileColumns([
    { region: "North", revenue: 100 },
    { region: "South", revenue: 200 },
  ]);

  it("blocks every type when the query has no rows", () => {
    const result = checkChartTypeEligibility("bar", { xField: "region", yFields: ["revenue"] }, {});
    expect(result.eligible).toBe(false);
  });

  it("bar/pie/treemap need an xField and a numeric yField", () => {
    expect(checkChartTypeEligibility("bar", { xField: "region", yFields: ["revenue"] }, profiles).eligible).toBe(true);
    expect(checkChartTypeEligibility("bar", { yFields: ["revenue"] }, profiles).eligible).toBe(false);
    expect(checkChartTypeEligibility("pie", { xField: "region", yFields: ["region"] }, profiles).eligible).toBe(false);
  });

  it("scatter requires a numeric xField, not just a numeric yField", () => {
    expect(checkChartTypeEligibility("scatter", { xField: "region", yFields: ["revenue"] }, profiles).eligible).toBe(false);
    expect(checkChartTypeEligibility("scatter", { xField: "revenue", yFields: ["revenue"] }, profiles).eligible).toBe(true);
  });

  it("gauge/bullet only need one numeric yField and ignore xField", () => {
    expect(checkChartTypeEligibility("gauge", { yFields: ["revenue"] }, profiles).eligible).toBe(true);
    expect(checkChartTypeEligibility("bullet", { yFields: ["region"] }, profiles).eligible).toBe(false);
  });

  it("radar needs an xField (the spokes) and a numeric yField, same as bar", () => {
    expect(checkChartTypeEligibility("radar", { xField: "region", yFields: ["revenue"] }, profiles).eligible).toBe(true);
    expect(checkChartTypeEligibility("radar", { yFields: ["revenue"] }, profiles).eligible).toBe(false);
    expect(checkChartTypeEligibility("radar", { xField: "region", yFields: ["region"] }, profiles).eligible).toBe(false);
  });

  it("streamgraph needs an xField and a numeric yField, same as area", () => {
    expect(checkChartTypeEligibility("streamgraph", { xField: "region", yFields: ["revenue"] }, profiles).eligible).toBe(true);
    expect(checkChartTypeEligibility("streamgraph", { yFields: ["revenue"] }, profiles).eligible).toBe(false);
  });

  it("sunburst falls back to xField as a single ring when hierarchyFields is unset", () => {
    expect(checkChartTypeEligibility("sunburst", { xField: "region", yFields: ["revenue"] }, profiles).eligible).toBe(true);
    // Neither xField nor hierarchyFields set — nothing to group by.
    expect(checkChartTypeEligibility("sunburst", { yFields: ["revenue"] }, profiles).eligible).toBe(false);
    // hierarchyFields alone (no xField) is also sufficient.
    expect(checkChartTypeEligibility("sunburst", { hierarchyFields: ["region"], yFields: ["revenue"] }, profiles).eligible).toBe(true);
    // Still needs a numeric yField regardless of how the levels are set.
    expect(checkChartTypeEligibility("sunburst", { xField: "region", yFields: ["region"] }, profiles).eligible).toBe(false);
  });

  it("sankey requires both a source (xField) and a target field, unlike every fallback-eligible type", () => {
    expect(checkChartTypeEligibility("sankey", { xField: "region", yFields: ["revenue"] }, profiles).eligible).toBe(false);
    expect(checkChartTypeEligibility("sankey", { xField: "region", targetField: "region", yFields: ["revenue"] }, profiles).eligible).toBe(true);
    expect(checkChartTypeEligibility("sankey", { targetField: "region", yFields: ["revenue"] }, profiles).eligible).toBe(false);
  });
});

describe("rankChartTypes", () => {
  it("covers all 16 chart types and sorts eligible ones first", () => {
    const profiles = profileColumns([{ region: "North", revenue: 100 }, { region: "South", revenue: 200 }]);
    const ranked = rankChartTypes({ xField: "region", yFields: ["revenue"] }, profiles);
    expect(ranked.map((r) => r.value).sort()).toEqual(CHART_TYPE_META.map((m) => m.value).sort());
    const firstIneligibleIdx = ranked.findIndex((r) => !r.eligible);
    if (firstIneligibleIdx !== -1) {
      expect(ranked.slice(0, firstIneligibleIdx).every((r) => r.eligible)).toBe(true);
    }
  });
});
