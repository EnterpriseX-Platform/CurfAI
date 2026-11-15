/**
 * What a catalog card's thumbnail draws: a miniature of the report's real
 * first page, read from the definition alone. Every block keeps its place on
 * the 12-column designer grid (x/y/w/h) and is drawn as a glyph of what it is
 * — a KPI tile, the chart's own type, a table, a map, running text. No query
 * runs and no data is loaded, so the list page stays cheap.
 *
 * Pure: definition in, model out. The renderer is ReportThumbnail.tsx.
 */

export type ThumbGlyph =
  | "kpi" | "bar" | "line" | "area" | "pie" | "gauge" | "scatter" | "funnel"
  | "table" | "heatmap" | "map" | "progress" | "image" | "title" | "text" | "divider";

/** One block on the thumbnail, in designer grid units (12 columns wide). */
export type ThumbCell = { glyph: ThumbGlyph; x: number; y: number; w: number; h: number };

export type ThumbModel = {
  /** Grid rows the thumbnail shows; the renderer scales them to its height. */
  rows: number;
  cells: ThumbCell[];
  /** KPI tiles on the first page. */
  kpis: number;
  /** The first page's charts, in reading order. */
  charts: ThumbGlyph[];
  /** Every block on every page — the card's "n blocks". */
  blocks: number;
};

export const THUMB_COLS = 12;
/** The most rows shown: deeper pages are cropped to their top, like a page's first screen. */
export const THUMB_MAX_ROWS = 16;

const CHART_GLYPH: Record<string, ThumbGlyph> = {
  bar: "bar", combo: "bar", waterfall: "bar",
  line: "line", radar: "line",
  area: "area", streamgraph: "area", sankey: "area",
  pie: "pie", donut: "pie", sunburst: "pie",
  gauge: "gauge", bullet: "progress",
  scatter: "scatter",
  funnel: "funnel",
  treemap: "heatmap",
};

const BLOCK_GLYPH: Record<string, ThumbGlyph | null> = {
  kpi: "kpi",
  table: "table", pivot: "table", cohort_retention: "table",
  heatmap: "heatmap",
  map: "map",
  funnel: "funnel",
  progress: "progress",
  image: "image",
  title: "title",
  text: "text", callout: "text",
  divider: "divider",
  pageBreak: null,
};

/** Where a block lands when the definition carries no grid position. */
const FLOW_SIZE: Partial<Record<ThumbGlyph, { w: number; h: number }>> = {
  kpi: { w: 3, h: 2 }, title: { w: 12, h: 1 }, text: { w: 12, h: 2 }, divider: { w: 12, h: 1 },
  table: { w: 12, h: 6 }, progress: { w: 6, h: 2 },
};
const FLOW_DEFAULT = { w: 6, h: 6 };

const CHARTS = new Set<ThumbGlyph>(["bar", "line", "area", "pie", "gauge", "scatter", "funnel"]);

function glyphOf(b: any): ThumbGlyph | null {
  if (b?.type === "chart") return CHART_GLYPH[b?.config?.chartType] ?? "bar";
  const g = BLOCK_GLYPH[b?.type];
  return g === undefined ? "text" : g;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function emptyModel(blocks = 0): ThumbModel {
  return { rows: 0, cells: [], kpis: 0, charts: [], blocks };
}

/** The thumbnail of a report definition (its JSON string or the parsed object). */
export function reportThumbnail(definition: unknown): ThumbModel {
  let def: any = definition;
  if (typeof definition === "string") {
    try { def = JSON.parse(definition); } catch { return emptyModel(); }
  }
  const pages: any[] = Array.isArray(def?.pages) ? def.pages : [];
  const all = pages.flatMap((p) => (Array.isArray(p?.blocks) ? p.blocks : []));
  // The first page that has something to draw — an empty cover page would
  // otherwise make every multi-page report look blank.
  const page = pages.find((p) => Array.isArray(p?.blocks) && p.blocks.some((b: any) => glyphOf(b) != null));
  if (!page) return emptyModel(all.length);

  const placed = page.blocks.filter((b: any) => glyphOf(b) != null);
  const positioned = placed.every((b: any) => isInt(b?.x) && isInt(b?.y) && isInt(b?.w) && isInt(b?.h));

  const cells: ThumbCell[] = [];
  if (positioned) {
    for (const b of placed) {
      const x = Math.min(Math.max(0, Math.round(b.x)), THUMB_COLS - 1);
      const w = Math.min(Math.max(1, Math.round(b.w)), THUMB_COLS - x);
      cells.push({ glyph: glyphOf(b)!, x, y: Math.max(0, Math.round(b.y)), w, h: Math.max(1, Math.round(b.h)) });
    }
  } else {
    // Flow layout: left to right, wrapping, the way an unplaced draft reads.
    let cx = 0, cy = 0, lineH = 0;
    for (const b of placed) {
      const glyph = glyphOf(b)!;
      const { w, h } = FLOW_SIZE[glyph] ?? FLOW_DEFAULT;
      if (cx + w > THUMB_COLS) { cx = 0; cy += lineH; lineH = 0; }
      cells.push({ glyph, x: cx, y: cy, w, h });
      cx += w; lineH = Math.max(lineH, h);
    }
  }

  // Reading order (top to bottom, then left to right) — the order the charts are listed in.
  cells.sort((a, b) => a.y - b.y || a.x - b.x);
  // Close the gap above the first block so a page that starts lower still fills the frame.
  const top = cells.length ? Math.min(...cells.map((c) => c.y)) : 0;
  for (const c of cells) c.y -= top;
  const bottom = Math.max(0, ...cells.map((c) => c.y + c.h));
  const rows = Math.min(bottom, THUMB_MAX_ROWS);
  const visible = cells
    .filter((c) => c.y < rows)
    .map((c) => ({ ...c, h: Math.min(c.h, rows - c.y) }));

  return {
    rows,
    cells: visible,
    kpis: cells.filter((c) => c.glyph === "kpi").length,
    charts: cells.filter((c) => CHARTS.has(c.glyph)).map((c) => c.glyph),
    blocks: all.length,
  };
}

/** A dashboard has no blocks of its own: its pinned KPIs across the top, then a panel per report it rotates. */
export function dashboardThumbnail(topKpis: number, reports: number): ThumbModel {
  const cells: ThumbCell[] = [];
  const k = Math.min(Math.max(0, topKpis), 4);
  for (let i = 0; i < k; i++) {
    const w = Math.floor(THUMB_COLS / k);
    cells.push({ glyph: "kpi", x: i * w, y: 0, w: i === k - 1 ? THUMB_COLS - i * w : w, h: 2 });
  }
  const panels: ThumbGlyph[] = ["bar", "line", "area", "pie"];
  const n = Math.min(Math.max(0, reports), 4);
  const y0 = k > 0 ? 2 : 0;
  for (let i = 0; i < n; i++) {
    const w = n === 1 ? THUMB_COLS : 6;
    cells.push({ glyph: panels[i], x: (i % 2) * 6, y: y0 + Math.floor(i / 2) * 5, w, h: 5 });
  }
  const rows = Math.max(0, ...cells.map((c) => c.y + c.h));
  return {
    rows, cells, kpis: k,
    charts: cells.filter((c) => CHARTS.has(c.glyph)).map((c) => c.glyph),
    blocks: reports,
  };
}
