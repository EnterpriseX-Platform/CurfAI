/**
 * ChartZoom wraps every chart: on screen it adds zoom controls around the
 * chart, unchanged; in print, or for a chart with nothing to zoom, it adds
 * nothing at all. The pointer and wheel behaviour is checked live in the
 * browser — there is no DOM test environment here.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChartZoom } from "./ChartZoom";

const labels = { zoomIn: "Zoom in", zoomOut: "Zoom out", reset: "Reset zoom" };
const chart = () => createElement("svg", { "data-x": "chart" });
const zoom = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(ChartZoom, { labels, ...props } as any, chart()));

describe("ChartZoom", () => {
  it("puts zoom in and out beside the chart, and no reset until zoomed", () => {
    const html = zoom({});
    expect(html).toContain('data-x="chart"');
    expect(html).toContain('aria-label="Zoom in"');
    expect(html).toContain('aria-label="Zoom out"');
    expect(html).not.toContain('aria-label="Reset zoom"');
    expect(html).not.toContain("data-chart-zoom");
  });

  it("adds nothing in print or when off", () => {
    expect(zoom({ print: true })).toBe('<svg data-x="chart"></svg>');
    expect(zoom({ enabled: false })).toBe('<svg data-x="chart"></svg>');
  });
});
