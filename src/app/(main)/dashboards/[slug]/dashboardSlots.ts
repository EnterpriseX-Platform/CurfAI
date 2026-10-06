/**
 * What each dashboard card shows from its report: the report's first visual
 * block, its first table, the report without its tables, or a chart drawn from
 * its first query when it has no visual block. Pure: DashboardViewer renders
 * whatever these pick through ReportBlock (components/reports/ReportDocument),
 * with the report's own theme, currency, date style and language, in the
 * interactive dashboard and the On Screen kiosk alike.
 */
import type { Block, Report } from "@/lib/reporting/schema";
import type { Dataset } from "@/lib/reporting/interpolate";

// We prioritize finding high-value visual blocks for the dashboard.
const VISUAL_KINDS = new Set(["chart", "progress", "pivot", "heatmap", "map", "funnel", "cohort_retention"]);

/** A report's blocks in reading order (top → bottom, left → right), as ReportDocument lays them out. */
function blocksInOrder(reportDef: Report | undefined | null): Block[] {
  if (!reportDef?.pages) return [];
  return reportDef.pages.flatMap((page) => [...(page.blocks ?? [])].sort((a, b) => (a.y - b.y) || (a.x - b.x)));
}

export function extractWidget(reportDef: Report | undefined | null): Block | null {
  return blocksInOrder(reportDef).find((b) => VISUAL_KINDS.has(b.type)) ?? null;
}

export function extractTable(reportDef: Report | undefined | null): Block | null {
  return blocksInOrder(reportDef).find((b) => b.type === "table") ?? null;
}

/**
 * Dashboards show only KPI/chart/visual blocks, never raw data tables —
 * a wall display or drill-down view is for reading a shape at a glance,
 * not scrolling a grid. Returns a shallow-cloned report with every page's
 * `table` blocks removed; every other block type passes through untouched.
 */
export function stripTables(reportDef: Report | undefined | null): any {
  if (!reportDef?.pages) return reportDef;
  return {
    ...reportDef,
    pages: reportDef.pages.map((page) => {
      const original = page.blocks ?? [];
      const kept = original.filter((b) => b.type !== "table");
      if (kept.length === original.length) return { ...page, blocks: kept };

      // ReportDocument places every block at an absolute CSS grid row
      // (gridRow: block.y+1 / span block.h) — removing a table without
      // re-flowing the blocks below it leaves a blank gap exactly the
      // table's height. Compact: a row collapses only if no *kept* block
      // still spans it (a block sitting beside the table keeps its row).
      const maxRow = original.reduce((m, b) => Math.max(m, b.y + b.h), 0);
      const occupied = new Array(maxRow).fill(false);
      for (const b of kept) {
        for (let r = b.y; r < b.y + b.h; r++) occupied[r] = true;
      }
      const rowMap = new Array(maxRow);
      let cursor = 0;
      for (let r = 0; r < maxRow; r++) {
        rowMap[r] = cursor;
        if (occupied[r]) cursor++;
      }
      return { ...page, blocks: kept.map((b) => ({ ...b, y: rowMap[b.y] })) };
    }),
  };
}

export function synthesizeChart(dataset: Record<string, unknown[]> | undefined): { block: Block, newData: any[] } | null {
  if (!dataset) return null;
  const queryIds = Object.keys(dataset);
  if (queryIds.length === 0) return null;

  const queryId = queryIds[0];
  const data = dataset[queryId];

  if (!data || !Array.isArray(data) || data.length === 0) return null;

  const firstRow = data[0] as Record<string, unknown>;
  const keys = Object.keys(firstRow);

  const stringCols = keys.filter(k => typeof firstRow[k] === "string");
  // Don't treat ID columns as metrics to plot
  const numberCols = keys.filter(k => (typeof firstRow[k] === "number" || typeof firstRow[k] === "bigint") && !/id$/i.test(k));

  if (stringCols.length > 0 && numberCols.length > 0) {
    // We have both strings and numbers, plot them directly
    return {
      block: {
        type: "chart",
        id: "auto_chart_" + queryId,
        x: 0, y: 0, w: 12, h: 8,
        config: {
          queryId,
          chartType: "bar",
          xField: stringCols[0],
          yFields: [numberCols[0]],
        },
      } as any,
      newData: data
    };
  } else if (stringCols.length > 0) {
    // Only strings: count frequencies of the first string column
    // Skip 'id' columns if possible
    const col = stringCols.find(c => !/id$/i.test(c)) || stringCols[0];
    const counts: Record<string, number> = {};
    for (const row of data) {
      const val = String((row as any)[col]);
      counts[val] = (counts[val] || 0) + 1;
    }
    const aggregated = Object.entries(counts).map(([k, v]) => ({ [col]: k, count: v }));
    return {
      block: {
        type: "chart",
        id: "auto_chart_" + queryId,
        x: 0, y: 0, w: 12, h: 8,
        config: {
          queryId,
          chartType: "bar",
          xField: col,
          yFields: ["count"],
        },
      } as any,
      newData: aggregated
    };
  } else if (numberCols.length > 0) {
    // Only numbers: plot them against row index
    const newData = data.map((row, i) => ({ ...(row as Record<string, any>), index: `Row ${i + 1}` }));
    return {
      block: {
        type: "chart",
        id: "auto_chart_" + queryId,
        x: 0, y: 0, w: 12, h: 8,
        config: {
          queryId,
          chartType: "line",
          xField: "index",
          yFields: [numberCols[0]],
        },
      } as any,
      newData
    };
  }
  return null; // Return null if no chart found, so we can try auto-charting
}

/** The chart a card shows, with the rows it draws; `auto` when it was drawn from the rows, not authored. */
export type SlotChart = { block: Block; dataset: Dataset; auto: boolean };

/** The report's first visual block over `dataset`, or a chart drawn from its first query when it has none. */
export function slotChart(reportDef: Report | undefined | null, dataset: Dataset | undefined): SlotChart | null {
  const own = extractWidget(reportDef);
  if (own) return { block: own, dataset: dataset ?? {}, auto: false };
  const made = synthesizeChart(dataset);
  if (!made) return null;
  return { block: made.block, dataset: { [(made.block.config as any).queryId]: made.newData }, auto: true };
}

/** The chart-only card's chart, without its AI caption: the card shows the axes under it instead. */
export function withoutAiCaption(block: Block): Block {
  return { ...block, config: { ...(block.config as any), showAiCaption: false } } as Block;
}

/** "X: region" and "Y: sales, cost" for a chart card's caption; blank for any other block. */
export function chartAxes(block: Block | null | undefined, t: (key: string) => string): { x: string; y: string } {
  const cfg = block?.type === "chart" ? (block.config as any) : null;
  return {
    x: cfg?.xField ? t("dashboardViewer.xAxisLabel").replace("{field}", cfg.xField) : "",
    y: cfg?.yFields?.length ? t("dashboardViewer.yAxisLabel").replace("{fields}", cfg.yFields.join(", ")) : "",
  };
}
