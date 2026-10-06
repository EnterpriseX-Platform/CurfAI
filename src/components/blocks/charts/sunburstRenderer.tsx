"use client";
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
 * Click a ring to zoom into it — its children fill the circle — and the
 * centre to step back out, the way the prototype reads a ministry's
 * departments; a leaf's click is the report's own (drill, cross-filter).
 * A print shows the whole tree.
 *
 * Deliberately does NOT wire renderReferenceLines/renderAnnotations/
 * renderForecastDecor — same reasoning as Treemap/Funnel/Radar: there is no
 * Cartesian axis for a Reference* element to anchor to.
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { hierarchy, partition, type HierarchyRectangularNode } from "d3-hierarchy";
import { arc as d3arc } from "d3-shape";
import { DEFAULT_PALETTE, TICK_FILL, formatValue, type ChartRenderCtx } from "./shared";

type TreeNode = { name: string; value?: number; children: TreeNode[] };
type Node = HierarchyRectangularNode<TreeNode>;
type Geom = { x0: number; x1: number; r0: number; r1: number; o: number };

const SIZE = 220;
const RADIUS = 100;
const INNER_HOLE = 26;
const TAU = 2 * Math.PI;
const ZOOM_MS = 550;

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

/** Where node d sits with `focus` at the centre: angles stretched so the
 *  focus spans the full circle, the levels under it sharing the radius
 *  outside the hole. Anything not under the focus collapses out of sight. */
export function sunburstGeom(d: Node, focus: Node, levels: number): Geom {
  const span = focus.x1 - focus.x0 || 1;
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const ring = (RADIUS - INNER_HOLE) / Math.max(1, levels - focus.depth);
  const k = d.depth - focus.depth - 1;
  const under = k >= 0 && d.ancestors().includes(focus);
  return {
    x0: clamp((d.x0 - focus.x0) / span) * TAU,
    x1: clamp((d.x1 - focus.x0) / span) * TAU,
    r0: under ? INNER_HOLE + k * ring : INNER_HOLE,
    r1: under ? INNER_HOLE + (k + 1) * ring - 1 : INNER_HOLE,
    o: under ? Math.max(0.4, 1 - (d.depth - 1) * 0.16) : 0,
  };
}

export function renderSunburstChart(ctx: ChartRenderCtx): ReactElement {
  return <Sunburst ctx={ctx} />;
}

function Sunburst({ ctx }: { ctx: ChartRenderCtx }) {
  const { data, xField, yFields, cfg, palette = DEFAULT_PALETTE, fmt, currency, handleClick, print } = ctx;
  const numOpts = { locale: ctx.dateStyle?.locale };
  const text = ctx.text ?? {};
  const levels: string[] = cfg?.hierarchyFields?.length ? cfg.hierarchyFields : [xField];
  const leafField = levels[levels.length - 1];
  const valueField = yFields[0];

  const tree = buildTree(data as Array<Record<string, unknown>>, levels, valueField);
  // partition() returns the same nodes widened to HierarchyRectangularNode
  // (x0/x1/y0/y1 added) — capture ITS return value, not the pre-partition
  // hierarchy(), so every downstream .children/.descendants() call sees the
  // rectangular type instead of the plain HierarchyNode.
  const root: Node = partition<TreeNode>().size([TAU, RADIUS])(
    hierarchy(tree)
      .sum((d) => d.value ?? 0)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0)),
  );
  const nodes = root.descendants().filter((d) => d.depth > 0);
  const pathOf = (d: Node) => d.ancestors().reverse().slice(1).map((a) => a.data.name);
  const find = (path: string[]) => nodes.find((d) => pathOf(d).join("\u0001") === path.join("\u0001")) ?? root;

  // The focus by its names, so new rows (a filter) keep the reader's zoom
  // when that branch still exists.
  const [focusPath, setFocusPath] = useState<string[]>([]);
  const [prevPath, setPrevPath] = useState<string[]>([]);
  const [k, setK] = useState(1);
  const raf = useRef(0);
  const zoomTo = (d: Node) => {
    if (print) return;
    setPrevPath(focusPath);
    setFocusPath(d === root ? [] : pathOf(d));
    cancelAnimationFrame(raf.current);
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ZOOM_MS);
      setK(1 - Math.pow(1 - t, 3));
      if (t < 1) raf.current = requestAnimationFrame(step);
    };
    setK(0);
    raf.current = requestAnimationFrame(step);
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const focus = print ? root : find(focusPath);
  const prev = print ? root : find(prevPath);

  const branchIndex = new Map(root.children?.map((c, i) => [c, i]) ?? []);
  function colorFor(d: Node): string {
    let n = d;
    while (n.depth > 1 && n.parent) n = n.parent;
    return palette[(branchIndex.get(n) ?? 0) % palette.length];
  }

  const lerp = (a: number, b: number) => a + (b - a) * k;
  const arcGen = d3arc<Geom>()
    .startAngle((g) => g.x0)
    .endAngle((g) => g.x1)
    .padAngle(0.004)
    .innerRadius((g) => g.r0)
    .outerRadius((g) => Math.max(g.r0, g.r1));

  const zoomed = focus !== root;
  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="h-full max-h-full w-full max-w-full">
      <g transform={`translate(${SIZE / 2},${SIZE / 2})`}>
        {nodes.map((d, i) => {
          const a = sunburstGeom(d, prev, levels.length);
          const b = sunburstGeom(d, focus, levels.length);
          const g = { x0: lerp(a.x0, b.x0), x1: lerp(a.x1, b.x1), r0: lerp(a.r0, b.r0), r1: lerp(a.r1, b.r1), o: lerp(a.o, b.o) };
          if (g.o < 0.01 || g.x1 - g.x0 < 1e-4) return null;
          const isLeaf = d.depth === levels.length;
          const canZoom = !isLeaf && !print && b.o > 0;
          return (
            <g key={i}>
            <path
              d={arcGen(g) ?? undefined}
              fill={colorFor(d)}
              fillOpacity={g.o}
              stroke="hsl(var(--card))"
              strokeWidth={1}
              onClick={canZoom ? () => zoomTo(d) : isLeaf ? () => handleClick({ payload: { [leafField]: d.data.name } }) : undefined}
              style={{ cursor: canZoom || isLeaf ? "pointer" : "default" }}
            >
              <desc className="chart-tip">{`${pathOf(d).join(" › ")}: ${formatValue(d.value ?? 0, fmt, currency, numOpts)}${canZoom && text.zoomIn ? `\n${text.zoomIn}` : ""}`}</desc>
            </path>
            {arcLabel(g, d.data.name, formatValue(d.value ?? 0, fmt, currency, numOpts))}
            </g>
          );
        })}
        <circle r={INNER_HOLE - 1} fill="transparent" onClick={zoomed ? () => zoomTo(focus.parent ?? root) : undefined}
          style={{ cursor: zoomed ? "pointer" : "default" }}>
          {zoomed && text.stepOut && <desc className="chart-tip">{text.stepOut}</desc>}
        </circle>
        <text textAnchor="middle" dominantBaseline="middle" y={zoomed ? -8 : -3} fontSize={zoomed ? 8 : 11} fontWeight={700} fill="hsl(var(--foreground))" pointerEvents="none">
          {zoomed ? clip(focus.data.name, 16) : formatValue(root.value ?? 0, fmt, currency, numOpts)}
        </text>
        <text textAnchor="middle" dominantBaseline="middle" y={zoomed ? 4 : 13} fontSize={zoomed ? 8 : 8.5} fontWeight={zoomed ? 600 : 400} fill={zoomed ? "hsl(var(--foreground))" : TICK_FILL} pointerEvents="none">
          {zoomed ? formatValue(focus.value ?? 0, fmt, currency, numOpts) : (text.total ?? "Total")}
        </text>
        {zoomed && (
          <text textAnchor="middle" dominantBaseline="middle" y={14} fontSize={6} fill={TICK_FILL} pointerEvents="none">↩</text>
        )}
      </g>
    </svg>
  );
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** A segment's name (and amount, where there's room) written on it — the
 *  prototype's labels. Along the ring when the segment is wider than the ring
 *  is thick (a big branch), outward along the radius otherwise (a thin
 *  slice); either way turned to read upright. Only where at least a few
 *  characters fit: a ring of "กร…" stubs is noise, not data. */
export function arcLabel(g: Geom, name: string, amount: string): ReactElement | null {
  const FONT = 5.5;
  const CHAR = FONT * 0.52;
  const mid = (g.r0 + g.r1) / 2;
  const across = (g.x1 - g.x0) * mid;
  const thick = g.r1 - g.r0;
  if (g.o < 0.3) return null;
  const along = across > thick * 1.2;
  // Room for the words, and for the lines stacked the other way.
  const length = (along ? across : thick) - 4;
  const depth = along ? thick : across;
  const fits = Math.floor(length / CHAR);
  if (depth < FONT + 2 || fits < 4) return null;
  const label = clip(name, fits);
  const twoLines = depth >= FONT * 2 + 3 && amount.length <= fits;
  const deg = (((g.x0 + g.x1) / 2) * 180) / Math.PI;
  const transform = along
    // Tangent at the segment's middle; the lower half turned to read upright.
    ? `rotate(${deg}) translate(0,${-mid}) rotate(${deg > 90 && deg < 270 ? 180 : 0})`
    : `rotate(${deg - 90}) translate(${mid},0) rotate(${deg >= 180 ? 180 : 0})`;
  return (
    <text transform={transform} textAnchor="middle"
      fontSize={FONT} fill="hsl(var(--foreground))" fillOpacity={Math.min(1, g.o * 1.4)} pointerEvents="none">
      <tspan x={0} dy={twoLines ? -FONT * 0.25 : FONT * 0.35} fontWeight={600}>{label}</tspan>
      {twoLines && <tspan x={0} dy={FONT * 1.1}>{amount}</tspan>}
    </text>
  );
}
