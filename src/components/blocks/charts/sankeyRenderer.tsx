"use client";
/**
 * Sankey — flow between stages (source -> target, sized by value). Hand-
 * drawn SVG via d3-sankey's layout + link-path generator, same
 * fixed-viewBox-scales-via-CSS pattern as Gauge.tsx and sunburstRenderer.tsx
 * (Recharts has no flow-layout primitive). Rendered OUTSIDE the
 * ResponsiveContainer wrapper — see ChartBlock.tsx's dispatch.
 *
 * Each row is one flow: xField = source node, cfg.targetField = destination
 * node, yFields[0] = flow value. Rows are aggregated (summed) by
 * source+target pair before layout, so a report author can hand this an
 * un-aggregated query and still get a clean diagram.
 *
 * Drill (cfg.hierarchyFields, broadest first — [ministry, department]): when
 * every flow row also names the first-column node it belongs to at each
 * level, clicking a first-column node (a ministry) puts its next level (its
 * departments) in that column and keeps only its flows all the way through —
 * the prototype's "click a ministry to see its departments". A breadcrumb
 * steps back. A node with no level below it keeps the report's own click.
 *
 * Deliberately does NOT wire renderReferenceLines/renderAnnotations/
 * renderForecastDecor — same reasoning as Treemap/Funnel/Radar/Sunburst:
 * there is no Cartesian axis for a Reference* element to anchor to.
 */
import { useState, type ReactElement } from "react";
import { sankey, sankeyLeft, sankeyLinkHorizontal } from "d3-sankey";
import { DEFAULT_PALETTE, LABEL_FILL, formatValue, type ChartRenderCtx } from "./shared";

const NAME_FILL = "hsl(var(--foreground))";

type NodeDatum = { id: string; name: string };
type LinkDatum = { source: string; target: string; value: number };
type Row = Record<string, unknown>;

const WIDTH = 560;
const HEIGHT = 220;
const NODE_WIDTH = 12;
const LEFT_LABELS = 104;
const RIGHT_LABELS = 104;
const SEP = "\u0000";

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * The flows to draw with `path` drilled into (one value per level taken):
 * only the rows under that path, and the first-column rows' source swapped
 * for the next level's value. A first-column row is one whose source is its
 * own top-level value — a stage-to-stage row (ผ่านคัดกรอง → อนุมัติ) carries
 * the ministry too, so it is filtered, but its source stays the stage.
 */
export function drilledFlows(rows: Row[], xField: string, levels: string[], path: string[]): Row[] {
  if (levels.length < 2 || path.length === 0) return rows;
  const at = levels[Math.min(path.length, levels.length - 1)]!;
  return rows
    .filter((r) => path.every((v, i) => String(r?.[levels[i]!] ?? "") === v))
    .map((r) => (String(r?.[xField] ?? "") === String(r?.[levels[0]!] ?? "") ? { ...r, [xField]: r?.[at] ?? "—" } : r));
}

/**
 * The graph for d3-sankey, which throws ("circular link") on any cycle. A
 * name that is both a source and a target of the same flow — อบต. บ้านกลาง's
 * budget has a plan and an expense category both called "งบกลาง" — is one
 * name in two roles, so a link whose target already leads back to its source
 * gets a second node with the same name, and the flow continues to the right
 * instead of taking the whole report down.
 */
export function acyclicGraph(flows: LinkDatum[]): { nodes: NodeDatum[]; links: LinkDatum[] } {
  const nodes = new Map<string, NodeDatum>();
  const out = new Map<string, Set<string>>();
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const n = stack.pop()!;
      if (n === to) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const next of out.get(n) ?? []) stack.push(next);
    }
    return false;
  };
  const ensure = (id: string, name: string) => { if (!nodes.has(id)) nodes.set(id, { id, name }); return id; };
  const links: LinkDatum[] = [];
  for (const f of flows) {
    const source = ensure(f.source, f.source);
    const target = ensure(f.target === source || reaches(f.target, source) ? `${f.target}${SEP}${SEP}` : f.target, f.target);
    links.push({ source, target, value: f.value });
    if (!out.has(source)) out.set(source, new Set());
    out.get(source)!.add(target);
  }
  return { nodes: [...nodes.values()], links };
}

export function renderSankeyChart(ctx: ChartRenderCtx): ReactElement {
  return <SankeyFlows ctx={ctx} />;
}

function SankeyFlows({ ctx }: { ctx: ChartRenderCtx }) {
  const { data, xField, yFields, cfg, palette = DEFAULT_PALETTE, fmt, currency, handleClick, print } = ctx;
  const numOpts = { locale: ctx.dateStyle?.locale };
  const text = ctx.text ?? {};
  const targetField: string = cfg?.targetField;
  const valueField = yFields[0];
  const rows = data as Row[];
  // Drill levels only where the rows carry them.
  const levels: string[] = Array.isArray(cfg?.hierarchyFields) && cfg.hierarchyFields.length >= 2
    && cfg.hierarchyFields.every((f: string) => rows.some((r) => r?.[f] != null))
    ? cfg.hierarchyFields : [];
  const [path, setPath] = useState<string[]>([]);
  const drill = print ? [] : path;
  const canDrill = levels.length >= 2 && drill.length < levels.length - 1 && !print;

  // Aggregate duplicate source+target rows before layout — d3-sankey draws
  // one link per entry, so un-aggregated rows would render as overlapping
  // duplicate ribbons instead of one correctly-sized one.
  const linkTotals = new Map<string, number>();
  for (const row of drilledFlows(rows, xField, levels, drill)) {
    const source = String(row?.[xField] ?? "—");
    const target = String(row?.[targetField] ?? "—");
    const value = Number(row?.[valueField]);
    if (!Number.isFinite(value) || value <= 0) continue;
    const key = `${source}${SEP}${target}`;
    linkTotals.set(key, (linkTotals.get(key) ?? 0) + value);
  }
  const { nodes, links } = acyclicGraph(
    Array.from(linkTotals.entries(), ([key, value]) => {
      const [source, target] = key.split(SEP);
      return { source: source!, target: target!, value };
    }),
  );

  if (nodes.length === 0 || links.length === 0) {
    return (
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-full max-h-full w-full max-w-full">
        <text x={WIDTH / 2} y={HEIGHT / 2} textAnchor="middle" fontSize={11} fill="#94a3b8">
          {ctx.emptyText ?? "No flows to show"}
        </text>
      </svg>
    );
  }

  const graph: any = sankey<NodeDatum, LinkDatum>()
    .nodeId((d: any) => d.id)
    // Left-aligned: a flow that ends early (rejected at screening) stays in
    // the column where it ended. The default justify pushes every end node to
    // the last column, which reads as if it had passed every stage before it.
    .nodeAlign(sankeyLeft)
    .nodeWidth(NODE_WIDTH)
    .nodePadding(12)
    // Room on the left for the first column's names, which sit outside
    // their nodes like the last column's do on the right; and on top for the
    // breadcrumb once drilled.
    .extent([
      [LEFT_LABELS, drill.length ? 20 : 8],
      [WIDTH - RIGHT_LABELS, HEIGHT - 8],
    ])({ nodes: nodes.map((d) => ({ ...d })), links: links.map((d) => ({ ...d })) });

  const nodeColor = new Map<string, string>();
  graph.nodes.forEach((n: any, i: number) => nodeColor.set(n.id, palette[i % palette.length]));
  const linkPath = sankeyLinkHorizontal();
  const crumbs = [text.all ?? "All", ...drill];

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-full max-h-full w-full max-w-full">
      {drill.length > 0 && (
        // Where the reader is, each step clickable back to it.
        <text x={4} y={10} fontSize={10} fill={LABEL_FILL}>
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <tspan key={i} fontWeight={last ? 600 : 400} fill={last ? NAME_FILL : "hsl(var(--primary))"}
                style={last ? undefined : { cursor: "pointer" }} onClick={last ? undefined : () => setPath(drill.slice(0, i))}>
                {(i ? " › " : "← ") + clip(c, 28)}
              </tspan>
            );
          })}
        </text>
      )}
      <g fillOpacity={0.35}>
        {graph.links.map((l: any, i: number) => (
          <path
            key={i}
            d={linkPath(l) ?? undefined}
            fill="none"
            stroke={nodeColor.get(l.source.id) ?? palette[0]}
            strokeOpacity={0.45}
            strokeWidth={Math.max(1, l.width ?? 1)}
          >
            <desc className="chart-tip">{`${l.source.name} → ${l.target.name}: ${formatValue(l.value, fmt, currency, numOpts)}`}</desc>
          </path>
        ))}
      </g>
      <g>
        {graph.nodes.map((n: any, i: number) => {
          // The first column's names sit to its left, every other column's to
          // its right — the frame keeps room on both sides for them.
          const labelOnRight = n.depth !== 0;
          const midY = (n.y0 + n.y1) / 2;
          // A thin node has no room for two lines: its name and amount on one,
          // or the amount ran into the next node's name.
          const oneLine = n.y1 - n.y0 < 20;
          const amount = formatValue(n.value ?? 0, fmt, currency, numOpts);
          const drillsIn = canDrill && n.depth === 0;
          return (
            <g key={i} onClick={() => (drillsIn ? setPath([...drill, n.name]) : handleClick({ payload: { [xField]: n.name } }))} style={{ cursor: "pointer" }}>
              <rect
                x={n.x0}
                y={n.y0}
                width={n.x1 - n.x0}
                height={Math.max(1, n.y1 - n.y0)}
                fill={nodeColor.get(n.id)}
                rx={2}
              >
                <desc className="chart-tip">{`${n.name}: ${amount}${drillsIn && text.drillIn ? `\n${text.drillIn}` : ""}`}</desc>
              </rect>
              <text
                x={labelOnRight ? n.x1 + 6 : n.x0 - 6}
                y={oneLine ? midY : midY - 5}
                dominantBaseline="middle"
                textAnchor={labelOnRight ? "start" : "end"}
                fontSize={10}
                fontWeight={500}
                fill={NAME_FILL}
              >
                {/* Both sides shortened: a long right-hand name ran off the frame when enlarged (2026-10-03).
                    A thin right-hand node shares its line with the amount, so the name gets what that leaves. */}
                {clip(n.name, oneLine ? (labelOnRight ? Math.min(14, Math.max(5, Math.floor((88 - 5 * amount.length) / 5.6))) : 9) : 20)}
                {oneLine && <tspan dx={6} fontSize={9} fontWeight={400} fill={LABEL_FILL}>{amount}</tspan>}
                <desc className="chart-tip">{`${n.name}: ${amount}${drillsIn && text.drillIn ? `\n${text.drillIn}` : ""}`}</desc>
              </text>
              {!oneLine && <text
                x={labelOnRight ? n.x1 + 6 : n.x0 - 6}
                y={midY + 7}
                dominantBaseline="middle"
                textAnchor={labelOnRight ? "start" : "end"}
                fontSize={9}
                fill={LABEL_FILL}
              >
                {amount}
              </text>}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
