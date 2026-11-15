import { describe, it, expect } from "vitest";
import { reportThumbnail, dashboardThumbnail, THUMB_MAX_ROWS } from "./thumbnailModel";

const block = (type: string, x: number, y: number, w: number, h: number, config: Record<string, unknown> = {}) =>
  ({ id: `${type}-${x}-${y}`, type, x, y, w, h, config });

describe("reportThumbnail", () => {
  it("keeps each first-page block at its grid position, as its own glyph", () => {
    const def = {
      pages: [{
        id: "p1", blocks: [
          block("kpi", 0, 0, 3, 2), block("kpi", 3, 0, 3, 2), block("kpi", 6, 0, 3, 2),
          block("chart", 0, 2, 8, 6, { chartType: "line" }),
          block("chart", 8, 2, 4, 6, { chartType: "donut" }),
          block("table", 0, 8, 12, 5),
        ],
      }],
    };
    const m = reportThumbnail(JSON.stringify(def));
    expect(m.kpis).toBe(3);
    expect(m.charts).toEqual(["line", "pie"]);
    expect(m.blocks).toBe(6);
    expect(m.rows).toBe(13);
    expect(m.cells).toContainEqual({ glyph: "line", x: 0, y: 2, w: 8, h: 6 });
    expect(m.cells).toContainEqual({ glyph: "table", x: 0, y: 8, w: 12, h: 5 });
  });

  it("lists charts in reading order, not definition order", () => {
    const m = reportThumbnail({
      pages: [{ blocks: [
        block("chart", 6, 4, 6, 4, { chartType: "area" }),
        block("map", 0, 4, 6, 4),
        block("chart", 0, 0, 12, 4, { chartType: "bar" }),
      ] }],
    });
    expect(m.cells.map((c) => c.glyph)).toEqual(["bar", "map", "area"]);
    expect(m.charts).toEqual(["bar", "area"]);
  });

  it("maps gated and related chart types to the nearest glyph", () => {
    const m = reportThumbnail({
      pages: [{ blocks: [
        block("chart", 0, 0, 3, 3, { chartType: "streamgraph" }),
        block("chart", 3, 0, 3, 3, { chartType: "sunburst" }),
        block("chart", 6, 0, 3, 3, { chartType: "gauge" }),
        block("chart", 9, 0, 3, 3, { chartType: "something-new" }),
      ] }],
    });
    expect(m.charts).toEqual(["area", "pie", "gauge", "bar"]);
  });

  it("crops a deep page to its top rows and clips the block crossing the edge", () => {
    const m = reportThumbnail({
      pages: [{ blocks: [block("chart", 0, 0, 12, 10, { chartType: "bar" }), block("table", 0, 10, 12, 20), block("text", 0, 40, 12, 2)] }],
    });
    expect(m.rows).toBe(THUMB_MAX_ROWS);
    expect(m.cells).toHaveLength(2);
    expect(m.cells[1]).toEqual({ glyph: "table", x: 0, y: 10, w: 12, h: THUMB_MAX_ROWS - 10 });
  });

  it("closes the gap above the first block and clamps out-of-range positions", () => {
    const m = reportThumbnail({ pages: [{ blocks: [block("kpi", 10, 5, 6, 2)] }] });
    expect(m.cells).toEqual([{ glyph: "kpi", x: 10, y: 0, w: 2, h: 2 }]);
  });

  it("flows blocks without grid positions left to right", () => {
    const m = reportThumbnail({
      pages: [{ blocks: [
        { type: "kpi", config: {} }, { type: "kpi", config: {} }, { type: "kpi", config: {} }, { type: "kpi", config: {} },
        { type: "chart", config: { chartType: "pie" } },
      ] }],
    });
    expect(m.cells.slice(0, 4).map((c) => [c.x, c.y])).toEqual([[0, 0], [3, 0], [6, 0], [9, 0]]);
    expect(m.cells[4]).toEqual({ glyph: "pie", x: 0, y: 2, w: 6, h: 6 });
  });

  it("skips an empty first page and page breaks, and counts blocks on every page", () => {
    const m = reportThumbnail({
      pages: [
        { blocks: [{ type: "pageBreak", x: 0, y: 0, w: 12, h: 1, config: {} }] },
        { blocks: [block("chart", 0, 0, 12, 6, { chartType: "scatter" })] },
        { blocks: [block("table", 0, 0, 12, 6)] },
      ],
    });
    expect(m.cells.map((c) => c.glyph)).toEqual(["scatter"]);
    expect(m.blocks).toBe(3);
  });

  it("returns an empty model for unreadable or empty definitions", () => {
    expect(reportThumbnail("{not json")).toEqual({ rows: 0, cells: [], kpis: 0, charts: [], blocks: 0 });
    expect(reportThumbnail({ pages: [] }).cells).toEqual([]);
    expect(reportThumbnail(null).rows).toBe(0);
  });
});

describe("dashboardThumbnail", () => {
  it("lays pinned KPIs across the top and a panel per report", () => {
    const m = dashboardThumbnail(3, 2);
    expect(m.kpis).toBe(3);
    expect(m.cells.filter((c) => c.glyph === "kpi").reduce((s, c) => s + c.w, 0)).toBe(12);
    expect(m.charts).toEqual(["bar", "line"]);
    expect(m.rows).toBe(7);
  });

  it("draws nothing for an empty dashboard", () => {
    expect(dashboardThumbnail(0, 0)).toMatchObject({ rows: 0, cells: [] });
  });
});
