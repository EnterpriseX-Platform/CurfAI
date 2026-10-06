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
    expect(html).toContain("25"); // aggregated value shown in the link's hover tip
  });

  it("draws a name that is both a source and a target as two nodes instead of throwing on the cycle", async () => {
    // อบต. บ้านกลาง: a plan and an expense category are both called "งบกลาง",
    // and d3-sankey throws "circular link" on the self-loop (2026-10-03).
    const ctx = baseCtx({
      xField: "plan",
      yFields: ["amount"],
      cfg: { targetField: "category" },
      data: [
        { plan: "งบกลาง", category: "งบกลาง", amount: 100 },
        { plan: "การศึกษา", category: "งบบุคลากร", amount: 60 },
        { plan: "การศึกษา", category: "งบกลาง", amount: 10 },
      ],
    });
    const html = renderToStaticMarkup(renderSankeyChart(ctx));
    expect((html.match(/<rect/g) ?? []).length).toBe(4);
    expect((html.match(/<path/g) ?? []).length).toBe(3);
    expect(html).toContain("งบกลาง → งบกลาง: 100");

    const { acyclicGraph } = await import("./sankeyRenderer");
    // A two-way flow keeps one node per role: the link back gets its own copy of the target.
    const g = acyclicGraph([{ source: "A", target: "B", value: 1 }, { source: "B", target: "A", value: 2 }]);
    expect(g.nodes.map((n) => n.name)).toEqual(["A", "B", "A"]);
    expect(new Set(g.nodes.map((n) => n.id)).size).toBe(3);
    expect(g.links[1]!.target).not.toBe("A");
  });

  it("shows a placeholder instead of crashing when there are no positive-value rows", () => {
    const ctx = baseCtx({ xField: "from", yFields: ["value"], cfg: { targetField: "to" }, data: [] });
    const html = renderToStaticMarkup(renderSankeyChart(ctx));
    expect(html).toContain("svg");
    expect((html.match(/<rect/g) ?? []).length).toBe(0);
  });
});

describe("sunburstGeom — zooming into a ring", () => {
  it("spreads the focus's children round the whole circle and hides the rest", async () => {
    const { hierarchy, partition } = await import("d3-hierarchy");
    const { sunburstGeom } = await import("./sunburstRenderer");
    const tree = { name: "root", children: [
      { name: "A", children: [{ name: "a1", value: 30, children: [] }, { name: "a2", value: 10, children: [] }] },
      { name: "B", children: [{ name: "b1", value: 60, children: [] }] },
    ] };
    const root = partition<any>().size([2 * Math.PI, 100])(hierarchy<any>(tree).sum((d) => d.value ?? 0));
    const A = root.children!.find((d) => d.data.name === "A")!;
    const [a1, a2] = A.children!;
    const b1 = root.children!.find((d) => d.data.name === "B")!.children![0]!;
    // Whole tree: two rings.
    expect(sunburstGeom(a1!, root, 2).r0).toBeGreaterThan(sunburstGeom(A, root, 2).r0);
    // Zoomed into A: its children make one ring round the full circle, 3:1.
    const g1 = sunburstGeom(a1!, A, 2), g2 = sunburstGeom(a2!, A, 2);
    expect(g1.x1 - g1.x0 + (g2.x1 - g2.x0)).toBeCloseTo(2 * Math.PI);
    expect((g1.x1 - g1.x0) / (g2.x1 - g2.x0)).toBeCloseTo(3);
    expect(g1.o).toBeGreaterThan(0);
    // A itself and B's branch are out of sight.
    expect(sunburstGeom(A, A, 2).o).toBe(0);
    expect(sunburstGeom(b1, A, 2).o).toBe(0);
  });
});

describe("drilledFlows — a Sankey's first column, one level down", () => {
  it("swaps a ministry for its departments and keeps only its flows, stages included", async () => {
    const { drilledFlows } = await import("./sankeyRenderer");
    const rows = [
      { source: "เกษตรฯ", target: "ผ่าน", m: "เกษตรฯ", d: "กรมชล", v: 10 },
      { source: "เกษตรฯ", target: "ผ่าน", m: "เกษตรฯ", d: "กรมพัฒน์", v: 5 },
      { source: "ผ่าน", target: "อนุมัติ", m: "เกษตรฯ", d: "กรมชล", v: 8 },
      { source: "คมนาคม", target: "ผ่าน", m: "คมนาคม", d: "ทางหลวง", v: 20 },
      { source: "ผ่าน", target: "อนุมัติ", m: "คมนาคม", d: "ทางหลวง", v: 18 },
    ];
    expect(drilledFlows(rows, "source", ["m", "d"], [])).toBe(rows);
    const out = drilledFlows(rows, "source", ["m", "d"], ["เกษตรฯ"]);
    expect(out.map((r) => [r.source, r.target, r.v])).toEqual([["กรมชล", "ผ่าน", 10], ["กรมพัฒน์", "ผ่าน", 5], ["ผ่าน", "อนุมัติ", 8]]);
  });
});

describe("clusterHome — a camera over the bunched points", () => {
  it("frames the Bangkok branches, not Chiang Mai; nothing when nothing bunches", async () => {
    const { clusterHome } = await import("../three/ProvinceColumns3D");
    const bkk: Array<[number, number]> = [[300, 600], [304, 596], [306, 604], [298, 590]];
    const home = clusterHome([...bkk, [100, 200]]);
    expect(home).not.toBeNull();
    expect(home!.r).toBeLessThan(400);
    expect(clusterHome([[0, 0], [500, 500], [100, 900]])).toBeNull();
    expect(clusterHome(bkk)).toBeNull();
  });
});

describe("3D scatter zone", () => {
  it("clamps a zone's box to each axis, an open end running to the edge", async () => {
    const { zoneSpan } = await import("../three/Scatter3D");
    expect(zoneSpan([3, null], [0, 10])).toEqual([3, 10]);
    expect(zoneSpan([null, 14], [2, 90])).toEqual([2, 14]);
    expect(zoneSpan(undefined, [5, 6])).toEqual([5, 6]);
  });
});
