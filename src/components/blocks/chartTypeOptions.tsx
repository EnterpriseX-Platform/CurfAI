/**
 * Shared icon + grouping glue between the two chart-type pickers:
 *   - ChartBlock.tsx's toolbar ChartTypeSelector (non-persisted "view as")
 *   - designer/ChartTypeField.tsx (the persisted Designer property)
 *
 * Kept separate from chartCompatibility.ts (which has no React/Node deps
 * and is also imported server-side by Master Builder/AutoCurf) so this
 * file's Lucide imports never end up in a server bundle that doesn't need
 * them.
 */
import {
  BarChart3, LineChart, AreaChart, PieChart, ChartNoAxesCombined,
  Boxes, Filter, BarChart4, ScatterChart, Radar, Gauge, Target,
  Sun, Workflow, Waves, BoxSelect, Network, CircleDot, Spline, Clock, Box, type LucideIcon,
} from "lucide-react";
import {
  CHART_TYPE_META, rankChartTypes, type ChartFieldConfig, type ChartPurpose,
  type ChartTypeValue, type ColumnProfile, type RankedChartType,
} from "@/lib/reporting/chartCompatibility";

export const CHART_TYPE_ICON: Record<ChartTypeValue, LucideIcon> = {
  bar: BarChart3,
  line: LineChart,
  area: AreaChart,
  combo: ChartNoAxesCombined,
  pie: PieChart,
  donut: PieChart,
  treemap: Boxes,
  funnel: Filter,
  waterfall: BarChart4,
  scatter: ScatterChart,
  radar: Radar,
  gauge: Gauge,
  bullet: Target,
  sunburst: Sun,
  sankey: Workflow,
  streamgraph: Waves,
  boxplot: BoxSelect,
  network: Network,
  chord: CircleDot,
  parallel: Spline,
  radial: Clock,
  scatter3d: Box,
};

/** Render the heading as t(`chartPurpose.${purpose}`) and each item as t(`chartType.${value}`). */
export type ChartTypeGroup = { purpose: ChartPurpose; items: RankedChartType[] };

/** Rank, then bucket by purpose in first-seen order (matches CHART_TYPE_META's own order). */
export function groupChartTypes(
  config: ChartFieldConfig,
  profiles: Record<string, ColumnProfile>,
): ChartTypeGroup[] {
  const ranked = rankChartTypes(config, profiles);
  const order: ChartPurpose[] = [];
  const seen = new Set<ChartPurpose>();
  for (const m of CHART_TYPE_META) {
    if (!seen.has(m.purpose)) { seen.add(m.purpose); order.push(m.purpose); }
  }
  return order.map((purpose) => ({ purpose, items: ranked.filter((r) => r.purpose === purpose) }));
}
