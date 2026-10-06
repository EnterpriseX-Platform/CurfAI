/**
 * Box plot, radial, parallel axes, network and chord — hand-drawn SVG with
 * no Recharts equivalent to lean on, so the arithmetic is tested directly
 * and each renders to real markup (renderToStaticMarkup works for plain SVG,
 * unlike the ResizeObserver-bound Recharts renderers).
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { boxStats, quantile, renderBoxPlotChart, renderRadialChart } from "./distributionRenderers";
import { linksOf, renderChordChart, renderNetworkChart } from "./networkChordRenderers";
import { renderParallelChart } from "./parallelRenderer";
import type { ChartRenderCtx } from "./shared";

function ctx(overrides: Partial<ChartRenderCtx>): ChartRenderCtx {
  return {
    data: [], xField: "x", yFields: ["y"], cfg: {},
    palette: ["#6366f1", "#10b981", "#f59e0b", "#f43f5e"], fmt: "number",
    handleClick: () => {}, renderReferenceLines: () => null, renderAnnotations: () => null, renderForecastDecor: () => null,
    ...overrides,
  };
}

describe("box plot statistics", () => {
  it("interpolates quartiles the way a spreadsheet does", () => {
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75);
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5);
    expect(quantile([7], 0.75)).toBe(7);
  });

  it("whiskers stop at 1.5×IQR and the rest are outliers, per group in query order", () => {
    const rows = [...[10, 11, 12, 13, 14, 15, 100].map((y) => ({ x: "B", y })), { x: "A", y: 5 }, { x: "A", y: null }];
    const [b, a] = boxStats(rows, "x", "y");
    expect(b).toMatchObject({ name: "B", n: 7, median: 13, q1: 11.5, q3: 14.5, lo: 10, hi: 15, outliers: [100] });
    // A null is not a zero.
    expect(a).toMatchObject({ name: "A", n: 1, median: 5 });
  });

  it("draws one box per category and says so when there's nothing to draw", () => {
    const html = renderToStaticMarkup(renderBoxPlotChart(ctx({ data: [{ x: "A", y: 1 }, { x: "A", y: 3 }, { x: "B", y: 2 }] })));
    expect(html.match(/<desc class="chart-tip">/g)?.length).toBe(2);
    expect(renderToStaticMarkup(renderBoxPlotChart(ctx({ data: [], emptyText: "ไม่มีข้อมูล" })))).toContain("ไม่มีข้อมูล");
  });
});

describe("radial", () => {
  it("keeps the query's order round the circle and names the peak", () => {
    const data = Array.from({ length: 24 }, (_, h) => ({ x: String(h), y: h === 18 ? 90 : 10 }));
    const html = renderToStaticMarkup(renderRadialChart(ctx({ data })));
    // One bar per hour (each hour also has a transparent hit area, so empty hours answer the pointer).
    expect(html.match(/<path d="[^"]+" fill="#/g)?.length).toBe(24);
    expect(html).toContain("18:00: 90");
    // At rest the middle names the peak hour.
    expect(html).toContain("Peak 18:00");
  });
});

it("puts open hours on a 24-hour face, so the day keeps its shape", () => {
  // Live: a shop open 9-20 had its 12 hours spread round the whole circle.
  const data = Array.from({ length: 12 }, (_, i) => ({ x: String(i + 9), y: 10 }));
  const html = renderToStaticMarkup(renderRadialChart(ctx({ data })));
  // 18:00 sits three quarters round (270°), not at slot 9 of 12.
  const d = html.match(/<path d="([^"]+)"[^>]*><desc class="chart-tip">18:00: 10/)![1]!;
  expect(d.startsWith("M-")).toBe(true);
});

it("keeps late hours late on the face, wherever they fall in the list", () => {
  // Hours 20-23 spread evenly would put 21:00 a quarter round (90°); on the
  // 24-hour face it's at 315°, left of the top. (A broken hour test let this slip once.)
  const data = [20, 21, 22, 23].map((h) => ({ x: String(h), y: 10 }));
  const html = renderToStaticMarkup(renderRadialChart(ctx({ data })));
  const d = html.match(/<path d="([^"]+)"[^>]*><desc class="chart-tip">21:00: 10/)![1]!;
  expect(d.startsWith("M-")).toBe(true);
});

it("stacks several measures in each hour — store then online — with a legend", () => {
  const data = [{ x: "9", store: 30, online: 10 }, { x: "20", store: 5, online: 40 }];
  const html = renderToStaticMarkup(renderRadialChart(ctx({ data, yFields: ["store", "online"], cfg: { seriesLabels: { store: "หน้าร้าน", online: "ออนไลน์" } } })));
  expect(html.match(/<path d="[^"]+" fill="#/g)?.length).toBe(4);
  expect(html).toContain("หน้าร้าน: 5");
  expect(html).toContain("ออนไลน์: 40");
  expect(html).toContain(">หน้าร้าน</text>");
});

describe("network and chord links", () => {
  it("sums duplicate pairs, counts a blank weight as one, drops self-links", () => {
    const rows = [
      { a: "R1", b: "R2", w: 2 }, { a: "R1", b: "R2", w: 3 },
      { a: "R2", b: "R3", w: null }, { a: "R4", b: "R4", w: 9 },
    ];
    expect(linksOf(rows, "a", "b", "w")).toEqual([
      { source: "R1", target: "R2", value: 5 },
      { source: "R2", target: "R3", value: 1 },
    ]);
  });

  it("lays a network out the same way every time", () => {
    const data = [{ x: "A", t: "B", y: 3 }, { x: "B", t: "C", y: 1 }, { x: "D", t: "E", y: 2 }];
    const draw = () => renderToStaticMarkup(renderNetworkChart(ctx({ data, cfg: { targetField: "t" } })));
    const html = draw();
    expect(html.match(/<circle/g)?.length).toBe(5);
    expect(html.match(/<line/g)?.length).toBe(3);
    // The viewer, the Designer and the PDF must show one picture.
    expect(draw()).toBe(html);
  });

  it("sizes a group that only receives by what it receives", () => {
    // Live: deals by source → segment drew the segments as slivers.
    const data = [{ x: "Partner", t: "Enterprise", y: 6 }, { x: "Inbound", t: "Enterprise", y: 4 }];
    const html = renderToStaticMarkup(renderChordChart(ctx({ data, cfg: { targetField: "t" } })));
    expect(html).toContain('<desc class="chart-tip">Enterprise: 10</desc>');
  });

  it("draws a chord with a ribbon per direction", () => {
    const data = [{ x: "Cat", t: "Dog", y: 4 }, { x: "Dog", t: "Cat", y: 2 }, { x: "Cat", t: "Fish", y: 1 }];
    const html = renderToStaticMarkup(renderChordChart(ctx({ data, cfg: { targetField: "t" } })));
    expect(html).toContain("Cat → Dog: 4");
    expect(html).toContain("Dog → Cat: 2");
    expect(renderToStaticMarkup(renderChordChart(ctx({ data: [], cfg: { targetField: "t" }, emptyText: "no links" })))).toContain("no links");
  });
});

describe("3D scatter", () => {
  it("keeps rows with all three measures and colours the largest groups", async () => {
    const { scatter3dPoints } = await import("../three/Scatter3D");
    const data = [
      { x: 1, y: 2, z: 3, g: "a" }, { x: 2, y: 3, z: null, g: "a" }, { x: 5, y: 1, z: 9, g: "b" }, { x: 4, y: 4, z: 4, g: "a" },
    ];
    const r = scatter3dPoints(data, "x", "y", "z", "g");
    // A missing depth isn't a point at depth zero.
    expect(r.pts).toHaveLength(3);
    expect(r.rx).toEqual([1, 5]);
    expect(r.rz).toEqual([3, 9]);
    expect(r.groups).toEqual(["a", "b"]);
  });

  it("prints flat: x against y, no WebGL", async () => {
    const { Scatter3D } = await import("../three/Scatter3D");
    const { createElement } = await import("react");
    const html = renderToStaticMarkup(createElement(Scatter3D, {
      palette: ["#6366f1"],
      ctx: ctx({ data: [{ x: 1, y: 2, z: 3 }, { x: 2, y: 4, z: 1 }], cfg: { zField: "z" }, print: true }),
    }));
    expect(html.match(/<circle/g)?.length).toBe(2);
    expect(html).not.toContain("canvas");
  });
});

describe("parallel axes", () => {
  it("draws a line per complete row across every numeric axis, coloured by category", () => {
    const data = [
      { x: "cost", a: 1, b: 5, c: 9 }, { x: "cost", a: 2, b: 4, c: 8 },
      { x: "overlap", a: 3, b: null, c: 7 }, { x: "none", a: 4, b: 2, c: 6 },
    ];
    const html = renderToStaticMarkup(renderParallelChart(ctx({ data, yFields: ["a", "b", "c"], cfg: { seriesLabels: { a: "ค่างาน" } } })));
    // The row with a gap on one axis isn't drawn as if it were zero.
    expect(html.match(/<polyline/g)?.length).toBe(3);
    expect(html).toContain("ค่างาน");
  });

  it("keeps only the rows inside every dragged range", async () => {
    const { rowsInRanges } = await import("./parallelRenderer");
    const rows = [{ a: 1, b: 5 }, { a: 3, b: 9 }, { a: 4, b: null }, { a: 2, b: 7 }];
    expect([...rowsInRanges(rows, { a: [1.5, 4] })]).toEqual([1, 2, 3]);
    // Both ranges at once; a missing value is outside any range.
    expect([...rowsInRanges(rows, { a: [1.5, 4], b: [6, 10] })]).toEqual([1, 3]);
  });

  it("needs two measures to have axes to join", () => {
    const html = renderToStaticMarkup(renderParallelChart(ctx({ data: [{ x: "a", y: 1 }], emptyText: "none" })));
    expect(html).toContain("none");
  });
});

describe("Pareto classes", () => {
  it("classes each item by the running share before it", async () => {
    const { paretoClass } = await import("./lineAreaComboRenderers");
    expect(paretoClass(0.5, 0.5)).toBe("A");
    // The item that crosses 80% is still A — it was needed to get there.
    expect(paretoClass(0.85, 0.1)).toBe("A");
    expect(paretoClass(0.9, 0.05)).toBe("B");
    expect(paretoClass(0.97, 0.01)).toBe("C");
  });
});

describe("network groups and link strength", () => {
  it("colours nodes by each end's group and draws habit links strong, chance links faint", async () => {
    const { renderNetworkChart } = await import("./networkChordRenderers");
    const data = [
      { a: "Cat food", b: "Cat litter", n: 50, ca: "Cat", cb: "Cat", lift: 2.2 },
      { a: "Cat food", b: "Dog toy", n: 40, ca: "Cat", cb: "Dog", lift: 0.9 },
    ];
    const html = renderToStaticMarkup(renderNetworkChart(ctx({
      data, xField: "a", yFields: ["n"],
      cfg: { targetField: "b", colorField: "ca", targetColorField: "cb", strengthField: "lift", strongAt: 1.5 },
      text: { strong: "habit", weak: "chance" },
    })));
    expect(html).toContain('stroke="hsl(var(--primary))"');
    expect(html).toContain("Cat food — Cat litter: 50 · Lift 2.2");
    expect(html).toContain(">habit</text>");
    expect(html).toContain(">Dog</text>");
  });
});

describe("readable when enlarged and on hover (2026-10-03)", () => {
  it("wraps a long network legend into rows inside the frame", () => {
    const cats = Array.from({ length: 8 }, (_, i) => `หมวดสินค้าที่ยาวมาก ${i}`);
    const data = cats.flatMap((c, i) => [{ x: `p${i}`, t: `q${i}`, y: 5 + i, ca: c, cb: c }]);
    const html = renderToStaticMarkup(renderNetworkChart(ctx({ data, cfg: { targetField: "t", colorField: "ca", targetColorField: "cb" } })));
    // Every legend item sits within the 720-wide frame; with eight long names that takes more than one row.
    const rows = new Set([...html.matchAll(/<g transform="translate\(([\d.]+),(\d+)\)"><circle cx="4"/g)].map((m) => {
      expect(Number(m[1]) + 22 + 18 * 5.6).toBeLessThanOrEqual(720);
      return m[2];
    }));
    expect(rows.size).toBeGreaterThan(1);
  });

  it("sets chord names level beside the ring, never turned along it", () => {
    const data = [{ x: "ยาและอาหารเสริม", t: "อาหารแมว", y: 4 }, { x: "ปลาและสัตว์น้ำ", t: "อาหารแมว", y: 2 }];
    const html = renderToStaticMarkup(renderChordChart(ctx({ data, cfg: { targetField: "t" } })));
    expect(html).not.toMatch(/<text transform="rotate/);
    expect(html).toContain(">ยาและอาหารเสริม</text>");
  });

  it("names the radial's peak hour in the middle at rest", () => {
    const data = [{ x: "9", y: 10 }, { x: "18", y: 90 }];
    const html = renderToStaticMarkup(renderRadialChart(ctx({ data, text: { peak: "สูงสุด" } })));
    expect(html).toContain("สูงสุด 18:00");
  });
});
