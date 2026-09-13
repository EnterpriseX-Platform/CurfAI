/**
 * Regression coverage for the Funnel label fix: Recharts' built-in
 * `<LabelList position="right">` assumes a monotonically narrowing funnel,
 * so unsorted rows (a real report's "leads by channel" query, not a staged
 * conversion funnel) produced a bowtie shape with an invisible label
 * (reported live: "nothing show"). renderFunnelChart now draws the name
 * centered inside each segment instead — this locks that behavior in with
 * genuinely out-of-order data, the exact shape that broke before.
 *
 * Two Recharts quirks both needed working around to make this testable:
 *
 *   1. Funnel only renders its LabelList once
 *      `!isAnimationActive || isAnimationFinished` (recharts/es6/numberAxis/
 *      Funnel.js), and isAnimationActive is wired to `!print` in
 *      renderFunnelChart. A live browser eventually flips isAnimationFinished
 *      after the 700ms grow-in animation; renderToStaticMarkup never fires
 *      that callback. Passing print:true sidesteps it — and is also the
 *      exact path a real PDF/print export takes, so this exercises that
 *      surface too, not just a test-only shortcut.
 *
 *   2. FunnelChart (like every Recharts auto-sizing chart wrapper —
 *      AreaChart, BarChart, ...) measures its container via ResizeObserver
 *      and renders nothing without a real browser layout, so
 *      renderToStaticMarkup returns "" regardless of #1. In the real app
 *      ResponsiveContainer supplies the measured size; here an explicit
 *      width/height is injected directly onto the root element via
 *      cloneElement so the chart has something to lay out against —
 *      test-only, no source change.
 */
import { cloneElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderFunnelChart } from "./scatterFunnelRenderers";
import type { ChartRenderCtx } from "./shared";

function renderSized(el: ReturnType<typeof renderFunnelChart>): string {
  return renderToStaticMarkup(cloneElement(el, { width: 600, height: 320 } as any));
}

function baseCtx(overrides: Partial<ChartRenderCtx>): ChartRenderCtx {
  return {
    data: [],
    xField: "x",
    yFields: ["y"],
    cfg: {},
    palette: ["#6366f1", "#10b981", "#f59e0b", "#f43f5e", "#06b6d4", "#8b5cf6"],
    fmt: "number",
    print: true,
    handleClick: () => {},
    renderReferenceLines: () => null,
    renderAnnotations: () => null,
    renderForecastDecor: () => null,
    ...overrides,
  };
}

describe("renderFunnelChart", () => {
  // Deliberately NOT sorted descending by leads — the exact shape that
  // produced the bowtie/invisible-label report.
  const unsortedRows = [
    { channel: "Search", leads: 61000 },
    { channel: "Events", leads: 11000 },
    { channel: "Social", leads: 29000 },
    { channel: "Display", leads: 6000 },
    { channel: "Email", leads: 7000 },
    { channel: "Partner", leads: 15000 },
  ];

  it("renders every channel name as visible text, regardless of row order", () => {
    const ctx = baseCtx({ xField: "channel", yFields: ["leads"], data: unsortedRows });
    const html = renderSized(renderFunnelChart(ctx));
    for (const row of unsortedRows) {
      expect(html).toContain(`>${row.channel}<`);
    }
    // White fill is what makes the label legible on every palette color —
    // the bug report was specifically that nothing was visible at all.
    expect(html).toContain('fill="#ffffff"');
  });

  it("adds the formatted value as a second label only when showDataLabels is on", () => {
    const ctx = baseCtx({ xField: "channel", yFields: ["leads"], data: unsortedRows, showDataLabels: true });
    const html = renderSized(renderFunnelChart(ctx));
    expect(html).toContain(">Search<");
    expect(html).toContain(">61,000<");
  });

  it("omits the value label when showDataLabels is off", () => {
    const ctx = baseCtx({ xField: "channel", yFields: ["leads"], data: unsortedRows, showDataLabels: false });
    const html = renderSized(renderFunnelChart(ctx));
    expect(html).not.toContain(">61,000<");
  });
});
