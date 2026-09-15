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

describe("renderFunnelChart — segment color", () => {
  // Regression: every row cycled through the categorical `palette` (bar/
  // pie's multi-series colors) — a rainbow with no meaning, and the exact
  // opposite of barRenderer.tsx's own "colour means something" contract.
  const ramp = ["#F5F3FF", "#C4B5FD", "#8B5CF6", "#6D28D9", "#4C1D95"]; // faint -> saturated
  const semantic = { success: "#0E7C5B", danger: "#B4304A", warning: "#A8690F", info: "#3B37D1", neutral: "#8A90A3" };
  const stages = [
    { stage: "Lead", n: 100 },
    { stage: "Qualified", n: 70 },
    { stage: "Discovery", n: 40 },
    { stage: "Negotiation", n: 20 },
    { stage: "Closed Won", n: 9 },
    { stage: "Closed Lost", n: 6 },
  ];

  it("shades ordinary stages from the theme's ramp, spread across however many rows there are", () => {
    // 5 non-terminal rows against a 5-stop ramp — every stop should get used.
    const pureProgression = stages.slice(0, 4).concat([{ stage: "Verbal Commit", n: 12 }]);
    const ctx = baseCtx({ xField: "stage", yFields: ["n"], data: pureProgression, ramp, semantic });
    const html = renderSized(renderFunnelChart(ctx));
    for (const hex of ramp) expect(html).toContain(`fill="${hex}"`);
    // None of the unrelated categorical palette colors leaked through.
    for (const hex of ["#6366f1", "#f59e0b", "#f43f5e"]) expect(html).not.toContain(`fill="${hex}"`);
  });

  it("colors a terminal win outcome with the theme's success token, not the ramp", () => {
    const ctx = baseCtx({ xField: "stage", yFields: ["n"], data: stages, ramp, semantic });
    const html = renderSized(renderFunnelChart(ctx));
    expect(html).toContain(`fill="${semantic.success}"`);
  });

  it("colors a terminal loss outcome with the theme's danger token, not the ramp", () => {
    const ctx = baseCtx({ xField: "stage", yFields: ["n"], data: stages, ramp, semantic });
    const html = renderSized(renderFunnelChart(ctx));
    expect(html).toContain(`fill="${semantic.danger}"`);
  });

  it("falls back to the categorical palette when no ramp is supplied, without crashing", () => {
    const ctx = baseCtx({ xField: "stage", yFields: ["n"], data: stages, ramp: undefined });
    expect(() => renderSized(renderFunnelChart(ctx))).not.toThrow();
  });

  it("leaves an ordinary mid-funnel stage on the ramp — no false positive on 'Discovery' or 'Negotiation'", () => {
    const rows = [{ stage: "Discovery", n: 10 }, { stage: "Negotiation", n: 5 }];
    const ctx = baseCtx({ xField: "stage", yFields: ["n"], data: rows, ramp, semantic });
    const html = renderSized(renderFunnelChart(ctx));
    expect(html).not.toContain(`fill="${semantic.success}"`);
    expect(html).not.toContain(`fill="${semantic.danger}"`);
  });
});
