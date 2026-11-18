/**
 * Chart types a report may only be SAVED with on a plan that has their
 * feature (Tier 2 viz roadmap). Reads stay open: a downgraded workspace still
 * sees its charts until someone re-saves. Shared by every route that writes a
 * chart type — the full report save (PUT /api/reports/[id]) and the viewer's
 * "save this chart type" (POST /api/reports/[id]/chart-type) — so the two
 * cannot drift apart.
 */
import type { FeatureKey } from "@/lib/featureTiers";
import type { Report } from "./schema";

export const GATED_CHART_TYPES: Readonly<Record<string, FeatureKey>> = {
  gauge:     "viz.chart.gauge",
  waterfall: "viz.chart.waterfall",
  bullet:    "viz.chart.bullet",
  sankey:    "viz.chart.sankey",
  boxplot:   "viz.chart.boxplot",
  network:   "viz.chart.network",
  chord:     "viz.chart.chord",
  parallel:  "viz.chart.parallel",
  radial:    "viz.chart.radial",
  scatter3d: "viz.chart.scatter3d",
};

/** The feature keys a report's charts need before it may be saved, each once. */
export function chartTypeFeaturesIn(report: Pick<Report, "pages">): FeatureKey[] {
  const out = new Set<FeatureKey>();
  for (const p of report.pages) {
    for (const b of p.blocks) {
      if (b.type !== "chart") continue;
      const key = GATED_CHART_TYPES[(b.config as any).chartType];
      if (key) out.add(key);
    }
  }
  return [...out];
}
