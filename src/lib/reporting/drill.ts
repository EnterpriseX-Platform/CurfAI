/**
 * Drill-through — what clicking a value on a block does, in one place for
 * the viewers, the drill route and the runner. Pure: safe in client code.
 *
 * Two kinds, configured per block (see DrillThroughSchema and the chart
 * config's drillParam in ./schema.ts):
 *   rows    `drilldown` — a slide-out panel of the rows behind the value,
 *           from a query that runs only on the click
 *   filter  `drillParam` — the value becomes that report parameter and the
 *           whole report re-runs, every block re-scoped together
 * A block with both filters: re-scoping the page is the deeper navigation.
 */
import { neededQueries, queryRefs } from "./queryRefs";
import type { DrillThrough, Report } from "./schema";

/** Block types a reader can drill from. */
export const DRILLABLE_BLOCKS = ["chart", "map", "table", "kpi", "heatmap"] as const;

export type BlockDrill =
  | { kind: "filter"; param: string }
  | { kind: "rows"; drilldown: DrillThrough };

/** The drill configured on a block, or null. A drillParam naming no parameter of the report is ignored. */
export function blockDrill(report: Pick<Report, "parameters">, block: { type: string; config: unknown }): BlockDrill | null {
  if (!(DRILLABLE_BLOCKS as readonly string[]).includes(block.type)) return null;
  const cfg = (block.config ?? {}) as { drilldown?: DrillThrough; drillParam?: string };
  if (cfg.drillParam && block.type !== "kpi" && report.parameters.some((p) => p.name === cfg.drillParam)) {
    return { kind: "filter", param: cfg.drillParam };
  }
  // A heatmap drills from its tiles by filter only (HeatmapBlock).
  if (cfg.drilldown?.queryId && block.type !== "heatmap") return { kind: "rows", drilldown: cfg.drilldown };
  return null;
}

/**
 * The queries only drills read: they run on the click (the drill route),
 * not every time the report loads — the clicked value they filter by
 * doesn't exist until then, and the rows behind every point of every chart
 * would otherwise be fetched for nobody.
 */
export function drillOnlyQueryIds(report: Pick<Report, "dataSources" | "pages">): Set<string> {
  const pages = report.pages ?? [];
  const targets = new Set(queryRefs(pages.flatMap((p) => (p.blocks ?? []).map((b) => (b.config as { drilldown?: unknown })?.drilldown))));
  if (targets.size === 0) return targets;
  const withoutDrills = pages.map((p) => ({
    ...p,
    blocks: (p.blocks ?? []).map((b) => {
      const { drilldown: _drill, ...rest } = (b.config ?? {}) as Record<string, unknown>;
      return { ...b, config: rest };
    }),
  }));
  const needed = neededQueries(report.dataSources, withoutDrills);
  return new Set([...targets].filter((id) => !needed.has(id)));
}
