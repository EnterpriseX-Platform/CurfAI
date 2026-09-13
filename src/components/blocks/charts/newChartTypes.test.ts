/**
 * Render-without-crashing smoke tests for the three hand-rolled/novel chart
 * types added alongside Radar (Streamgraph, Sunburst, Sankey). These don't
 * have a Recharts-native equivalent to lean on for correctness the way
 * bar/line/area do, so a real render pass (via renderToStaticMarkup, not
 * just calling the eligibility/schema layer) is the cheapest way to catch a
 * broken d3-hierarchy/d3-sankey/Recharts wiring before it reaches a browser.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderStreamgraphChart } from "./streamgraphRenderer";
import { renderSunburstChart } from "./sunburstRenderer";
import { renderSankeyChart } from "./sankeyRenderer";
import type { ChartRenderCtx } from "./shared";

function baseCtx(overrides: Partial<ChartRenderCtx>): ChartRenderCtx {
  return {
    data: [],
    xField: "x",
    yFields: ["y"],
    cfg: {},
    palette: ["#6366f1", "#10b981", "#f59e0b", "#f43f5e"],
    fmt: "number",
    handleClick: () => {},
    renderReferenceLines: () => null,
    renderAnnotations: () => null,
    renderForecastDecor: () => null,
    ...overrides,
  };
}

describe("renderStreamgraphChart", () => {
  // Recharts' Cartesian components (AreaChart included) measure their
  // container via ResizeObserver and render nothing without a real browser
  // layout — renderToStaticMarkup legitimately returns "" for them, the
  // same as it would for this codebase's other Recharts-composed renderers
  // (bar/line/area/combo/...). That's a tooling ceiling, not a bug, so the
  // meaningful assertion here is "the element tree builds without
  // throwing" — actual visual output is verified live in the browser.
  it("builds without throwing for multiple wiggle-stacked series", () => {
    const ctx = baseCtx({
      xField: "month",
      yFields: ["search", "social", "email"],
      data: [
        { month: "Jan", search: 100, social: 80, email: 40 },
        { month: "Feb", search: 120, social: 60, email: 55 },
        { month: "Mar", search: 90, social: 110, email: 30 },
      ],
    });
    expect(() => renderToStaticMarkup(renderStreamgraphChart(ctx))).not.toThrow();
  });
});

describe("renderSunburstChart", () => {
  const rows = [
    { region: "APAC", country: "Thailand", city: "Bangkok", revenue: 100 },
    { region: "APAC", country: "Thailand", city: "Chiang Mai", revenue: 40 },
    { region: "APAC", country: "Japan", city: "Tokyo", revenue: 200 },
    { region: "EMEA", country: "UK", city: "London", revenue: 150 },
  ];

  it("falls back to a single ring keyed by xField when hierarchyFields is unset", () => {
    const ctx = baseCtx({ xField: "region", yFields: ["revenue"], data: rows, cfg: {} });
    const html = renderToStaticMarkup(renderSunburstChart(ctx));
    // Two distinct regions -> two arcs at the single ring level.
    expect((html.match(/<path/g) ?? []).length).toBe(2);
    expect(html).toContain("490"); // total = 100+40+200+150
  });

  it("draws one ring per hierarchyFields level (region -> country -> city)", () => {
    const ctx = baseCtx({
      xField: "region",
      yFields: ["revenue"],
      data: rows,
      cfg: { hierarchyFields: ["region", "country", "city"] },
    });
    const html = renderToStaticMarkup(renderSunburstChart(ctx));
    // 2 regions + 3 countries + 4 cities = 9 arcs across all rings.
    expect((html.match(/<path/g) ?? []).length).toBe(9);
  });
});

describe("renderSankeyChart", () => {
  it("lays out nodes and links from source/target/value rows", () => {
    const ctx = baseCtx({
      xField: "department",
      yFields: ["amount"],
      cfg: { targetField: "category" },
      data: [
        { department: "Engineering", category: "Salaries", amount: 500 },
        { department: "Engineering", category: "Tools", amount: 50 },
        { department: "Sales", category: "Salaries", amount: 300 },
        { department: "Sales", category: "Travel", amount: 40 },
      ],
    });
    const html = renderToStaticMarkup(renderSankeyChart(ctx));
    expect(html).toContain("Engineering");
    expect(html).toContain("Salaries");
    // 4 distinct nodes (Engineering, Sales, Salaries, Tools, Travel = 5) + 4 links.
    expect((html.match(/<rect/g) ?? []).length).toBe(5);
  });

  it("aggregates duplicate source+target rows into one link instead of overlapping ribbons", () => {
    const ctx = baseCtx({
      xField: "from",
      yFields: ["value"],
      cfg: { targetField: "to" },
      data: [
        { from: "A", to: "B", value: 10 },
        { from: "A", to: "B", value: 15 },
      ],
    });
    const html = renderToStaticMarkup(renderSankeyChart(ctx));
    expect((html.match(/<path/g) ?? []).length).toBe(1);
    expect(html).toContain("25"); // aggregated value shown in the link's <title>
  });

  it("shows a placeholder instead of crashing when there are no positive-value rows", () => {
    const ctx = baseCtx({ xField: "from", yFields: ["value"], cfg: { targetField: "to" }, data: [] });
    const html = renderToStaticMarkup(renderSankeyChart(ctx));
    expect(html).toContain("svg");
    expect((html.match(/<rect/g) ?? []).length).toBe(0);
  });
});
