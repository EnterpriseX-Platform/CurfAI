/**
 * A bar chart dropped its value axis whenever the numbers were written on the bars (a single series in the
 * Modern/Enterprise styles, or a short horizontal ranking in any style), so readers saw "no X and Y" on a bar
 * chart while the same data switched to a line showed both. Both axes now always draw; the labels stay.
 * Rendered the way scatterFunnelRenderers.test.ts does: print (no animation) and an explicit size.
 */
import { Children, Fragment, cloneElement, isValidElement, type ReactElement } from "react";
import { XAxis, YAxis } from "recharts";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderBarChart } from "./barRenderer";
import { resolveChartStyle } from "@/lib/reporting/chartStyles";
import type { ChartRenderCtx } from "./shared";

const rows = [
  { centre: "BC00", units: 2094 }, { centre: "BC07", units: 2694 }, { centre: "BC03", units: 237 }, { centre: "BC11", units: 816 },
];
function render(overrides: Partial<ChartRenderCtx>): string {
  const ctx: ChartRenderCtx = {
    data: rows, xField: "centre", yFields: ["units"], cfg: {}, palette: ["#6366f1"], fmt: "number", print: true,
    handleClick: () => {}, renderReferenceLines: () => null, renderAnnotations: () => null, renderForecastDecor: () => null,
    ...overrides,
  };
  return renderToStaticMarkup(cloneElement(renderBarChart(ctx), { width: 640, height: 320 } as any));
}
const axes = (html: string) => ({
  x: /class="recharts-layer recharts-cartesian-axis recharts-xAxis/.test(html),
  y: /class="recharts-layer recharts-cartesian-axis recharts-yAxis/.test(html),
});

describe("bar chart axes", () => {
  it("keeps both axes on a single series with its numbers on the bars (Modern style)", () => {
    const html = render({ style: resolveChartStyle("modern"), showDataLabels: true });
    expect(axes(html)).toEqual({ x: true, y: true });
    expect(html).toContain("BC07"); // category ticks
    expect(html).toContain("recharts-label-list"); // the numbers on the bars are still there
  });

  it("keeps both axes on a short horizontal ranking", () => {
    const html = render({ cfg: { orientation: "horizontal" } });
    expect(axes(html)).toEqual({ x: true, y: true });
  });

  it("keeps both axes in the Enterprise style", () => {
    expect(axes(render({ style: resolveChartStyle("enterprise") }))).toEqual({ x: true, y: true });
  });
});

// Recharts finds its axes among the chart's DIRECT children. Its react-is (18) cannot see inside a fragment made by
// the React 19 that Next's app router runs, so an axis wrapped in <>...</> vanished in the browser while the server
// render above (React 18) still drew it. This holds the shape that works in both: no fragment, both axes direct.
describe("bar chart axes are direct children of the chart", () => {
  const kids = (el: ReactElement) => Children.toArray((el.props as any).children).filter(isValidElement) as ReactElement[];
  for (const orientation of ["vertical", "horizontal"] as const) {
    it(`${orientation}: an XAxis and a YAxis, and no fragment`, () => {
      const el = renderBarChart({
        data: rows, xField: "centre", yFields: ["units"], cfg: { orientation }, palette: ["#6366f1"], fmt: "number", print: true,
        handleClick: () => {}, renderReferenceLines: () => null, renderAnnotations: () => null, renderForecastDecor: () => null,
      } as ChartRenderCtx);
      const types = kids(el).map((k) => k.type);
      expect(types).toContain(XAxis);
      expect(types).toContain(YAxis);
      expect(types).not.toContain(Fragment);
    });
  }
});
