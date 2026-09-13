/**
 * Sunburst — multi-level composition rings (region -> country -> city).
 * Hand-drawn SVG, not a Recharts primitive (Recharts has no partition/arc
 * layout), same pattern as Gauge.tsx: a fixed-coordinate viewBox that scales
 * to whatever box the block gives it via CSS, no ResizeObserver needed.
 * Rendered OUTSIDE the ResponsiveContainer wrapper in ChartBlockInner for
 * the same reason Gauge/Bullet are — see ChartBlock.tsx's dispatch.
 *
 * Levels come from cfg.hierarchyFields (center-to-edge order). When unset,
 * falls back to a single ring keyed by xField — see checkChartTypeEligibility
 * ("sunburst") in chartCompatibility.ts for why that fallback is always
 * eligible instead of requiring hierarchyFields up front.
 *
 * Deliberately does NOT wire renderReferenceLines/renderAnnotations/
 * renderForecastDecor — same reasoning as Treemap/Funnel/Radar: there is no
 * Cartesian axis for a Reference* element to anchor to.
 */
import type { ReactElement } from "react";
import { hierarchy, partition, type HierarchyRectangularNode } from "d3-hierarchy";
import { arc as d3arc } from "d3-shape";
import { DEFAULT_PALETTE, TICK_FILL, formatValue, type ChartRenderCtx } from "./shared";

type TreeNode = { name: string; value?: number; children: TreeNode[] };

const SIZE = 220;
const RADIUS = 100;
const INNER_HOLE = 26;

function buildTree(rows: Array<Record<string, unknown>>, levels: string[], valueField: string): TreeNode {
  const root: TreeNode = { name: "root", children: [] };
  for (const row of rows) {
    let node = root;
    for (const level of levels) {
      const key = String(row?.[level] ?? "—");
      let child = node.children.find((c) => c.name === key);
      if (!child) {
        child = { name: key, children: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.value = (node.value ?? 0) + (Number(row?.[valueField]) || 0);
  }
  return root;
}

/** Remaps a partition radius (0..RADIUS) onto (INNER_HOLE..RADIUS) so the
 *  center always has room for the total label, regardless of how many
 *  levels the hierarchy actually has (1-level Sunburst would otherwise be a
 *  solid disk with no hole to put the total in). */
function remapRadius(y: number): number {
  return INNER_HOLE + (y / RADIUS) * (RADIUS - INNER_HOLE);
}

export function renderSunburstChart(ctx: ChartRenderCtx): ReactElement {
  const { data, xField, yFields, cfg, palette = DEFAULT_PALETTE, fmt, currency, handleClick } = ctx;
  const levels: string[] = cfg?.hierarchyFields?.length ? cfg.hierarchyFields : [xField];
  const leafField = levels[levels.length - 1];
  const valueField = yFields[0];

  const tree = buildTree(data as Array<Record<string, unknown>>, levels, valueField);
  // partition() returns the same nodes widened to HierarchyRectangularNode
  // (x0/x1/y0/y1 added) — capture ITS return value, not the pre-partition
  // hierarchy(), so every downstream .children/.descendants() call sees the
  // rectangular type instead of the plain HierarchyNode.
  const root: HierarchyRectangularNode<TreeNode> = partition<TreeNode>().size([2 * Math.PI, RADIUS])(
    hierarchy(tree)
      .sum((d) => d.value ?? 0)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0)),
  );

  const branchIndex = new Map(root.children?.map((c, i) => [c, i]) ?? []);
  function colorFor(d: HierarchyRectangularNode<TreeNode>): string {
    let n = d;
    while (n.depth > 1 && n.parent) n = n.parent;
    return palette[(branchIndex.get(n) ?? 0) % palette.length];
  }

  const arcGen = d3arc<HierarchyRectangularNode<TreeNode>>()
    .startAngle((d) => d.x0)
    .endAngle((d) => d.x1)
    .padAngle(0.004)
    .innerRadius((d) => remapRadius(d.y0))
    .outerRadius((d) => remapRadius(d.y1) - 1);

  const nodes = root.descendants().filter((d) => d.depth > 0);
  const total = root.value ?? 0;

  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="h-full max-h-full w-full max-w-full">
      <g transform={`translate(${SIZE / 2},${SIZE / 2})`}>
        {nodes.map((d, i) => {
          const isLeaf = d.depth === levels.length;
          const opacity = Math.max(0.4, 1 - (d.depth - 1) * 0.16);
          return (
            <path
              key={i}
              d={arcGen(d) ?? undefined}
              fill={colorFor(d)}
              fillOpacity={opacity}
              stroke="#ffffff"
              strokeWidth={1}
              onClick={isLeaf ? () => handleClick({ payload: { [leafField]: d.data.name } }) : undefined}
              style={{ cursor: isLeaf ? "pointer" : "default" }}
            >
              <title>{`${d.data.name}: ${formatValue(d.value ?? 0, fmt, currency)}`}</title>
            </path>
          );
        })}
        <text textAnchor="middle" dominantBaseline="middle" y={-3} fontSize={13} fontWeight={700} fill="hsl(var(--foreground))">
          {formatValue(total, fmt, currency)}
        </text>
        <text textAnchor="middle" dominantBaseline="middle" y={13} fontSize={8.5} fill={TICK_FILL}>
          TOTAL
        </text>
      </g>
    </svg>
  );
}
