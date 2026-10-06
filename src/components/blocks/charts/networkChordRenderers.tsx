"use client";
/**
 * Network and chord — which items are linked, and how strongly. Both read
 * the Sankey's row shape: xField = one end, cfg.targetField = the other,
 * yFields[0] = the weight (a count is fine). Duplicate pairs are summed
 * before layout. Hand-drawn SVG, rendered OUTSIDE ChartBlock's
 * ResponsiveContainer, in a fixed viewBox scaled by CSS (sankeyRenderer.tsx).
 *
 * Network: d3-force laid out to rest before it is drawn (300 ticks, no
 * animation), so the viewer, the Designer preview and the PDF capture all
 * show the same picture — d3-force seeds its own positions deterministically.
 * Nodes are sized by total weight and coloured by connected cluster: a
 * colour means "these are linked to each other", never decoration — or, with
 * cfg.colorField / targetColorField (each end's group: a product's category),
 * by group, with a legend. With cfg.strengthField and strongAt (lift ≥ 1.5),
 * a link at or above it is drawn strong in the accent, the rest faint:
 * bought together by habit, against together by chance.
 * Chord: the strongest groups round a circle, ribbons between them.
 */
import { useMemo, useRef, useState, type ReactElement } from "react";
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import { chordDirected, ribbon as d3ribbon } from "d3-chord";
import { arc } from "d3-shape";
import { DEFAULT_PALETTE, DEEMPHASIS_FILL, GRID_STROKE, LABEL_FILL, formatValue, seriesName, type ChartRenderCtx } from "./shared";

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function empty(w: number, h: number, text: string): ReactElement {
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-full max-h-full w-full max-w-full">
      <text x={w / 2} y={h / 2} textAnchor="middle" fontSize={11} fill={LABEL_FILL}>{text}</text>
    </svg>
  );
}

type Edge = { source: string; target: string; value: number; strength?: number };

/** Sum duplicate pairs; a self-link carries no relationship and is dropped. */
export function linksOf(data: unknown[], xField: string, targetField: string, yField: string, strengthField?: string): Edge[] {
  const sum = new Map<string, Edge>();
  for (const row of data as Array<Record<string, unknown>>) {
    const s = row?.[xField], t = row?.[targetField];
    if (s == null || t == null || String(s) === String(t)) continue;
    const raw = row?.[yField];
    const v = raw == null || raw === "" ? 1 : Number(raw);
    if (!Number.isFinite(v) || v <= 0) continue;
    const key = `${s}\u0000${t}`;
    const e = sum.get(key) ?? { source: String(s), target: String(t), value: 0 };
    e.value += v;
    const st = strengthField ? Number(row?.[strengthField]) : NaN;
    if (Number.isFinite(st)) e.strength = Math.max(e.strength ?? -Infinity, st);
    sum.set(key, e);
  }
  return [...sum.values()];
}

// Wide: a network is laid out full width (layoutVisuals), so its frame is too.
const NW = 720;
const NH = 300;
const MAX_NODES = 80;

type Node = SimulationNodeDatum & { id: string; weight: number; cluster: number };

export function renderNetworkChart(ctx: ChartRenderCtx): ReactElement {
  return <NetworkGraph ctx={ctx} />;
}

/** The legend's items in rows that fit the frame: a long category list wraps instead of running off the edge. */
function legendRows(items: Array<{ label: string }>, width: number): number[][] {
  const rows: number[][] = [[]];
  let x = 0;
  items.forEach((it, i) => {
    const w = legendItemWidth(it.label);
    if (x + w > width && rows[rows.length - 1]!.length) { rows.push([]); x = 0; }
    rows[rows.length - 1]!.push(i);
    x += w;
  });
  return rows;
}
const legendItemWidth = (label: string) => 22 + Math.min(label.length, 18) * 5.6;

type Link = Edge & { source: Node; target: Node };
type Layout = {
  nodes: Node[];
  links: Link[];
  groupOf: Map<string, string>;
  groups: string[];
  legend: Array<{ key: string; label: string; fill: string; line: boolean; x: number; row: number }>;
  legendH: number;
  radius: (n: Node) => number;
  maxE: number;
  strongAt: number | null;
  neighbours: Map<string, Set<string>>;
};

/**
 * The picture before anyone touches it: d3-force run to rest (300 ticks, no
 * animation, deterministic), then fitted to the frame — each axis on its own,
 * so a round cluster fills a wide card instead of sitting in its middle third
 * (Pet Lovers' 40 product pairs, 2026-10-03). Room is kept at the bottom for
 * the legend's rows.
 */
function layoutNetwork(ctx: ChartRenderCtx): Layout | null {
  const { data, xField, yFields, cfg, palette = DEFAULT_PALETTE } = ctx;
  let edges = linksOf(data, xField, cfg?.targetField, yFields[0]!, cfg?.strengthField);
  if (edges.length === 0) return null;
  // Each node's group, from whichever end it appears on.
  const groupOf = new Map<string, string>();
  if (cfg?.colorField || cfg?.targetColorField) {
    for (const row of data as Array<Record<string, unknown>>) {
      const s = row?.[xField], t = row?.[cfg?.targetField];
      const gs = cfg?.colorField ? row?.[cfg.colorField] : null, gt = cfg?.targetColorField ? row?.[cfg.targetColorField] : null;
      if (s != null && gs != null && gs !== "") groupOf.set(String(s), String(gs));
      if (t != null && gt != null && gt !== "") groupOf.set(String(t), String(gt));
    }
  }
  const strongAt = typeof cfg?.strongAt === "number" && cfg?.strengthField ? cfg.strongAt : null;

  // The strongest nodes, and only the links between them.
  const weight = new Map<string, number>();
  for (const e of edges) {
    weight.set(e.source, (weight.get(e.source) ?? 0) + e.value);
    weight.set(e.target, (weight.get(e.target) ?? 0) + e.value);
  }
  const kept = new Set([...weight].sort((a, b) => b[1] - a[1]).slice(0, MAX_NODES).map(([id]) => id));
  edges = edges.filter((e) => kept.has(e.source) && kept.has(e.target));

  // Connected clusters (union-find): a node's colour is its cluster's.
  const parent = new Map<string, string>([...kept].map((id) => [id, id]));
  const find = (x: string): string => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
  for (const e of edges) parent.set(find(e.source), find(e.target));
  const clusterSize = new Map<string, number>();
  for (const id of kept) clusterSize.set(find(id), (clusterSize.get(find(id)) ?? 0) + (weight.get(id) ?? 0));
  const clusterRank = new Map([...clusterSize].sort((a, b) => b[1] - a[1]).map(([root], i) => [root, i]));

  const nodes: Node[] = [...kept].map((id) => ({ id, weight: weight.get(id) ?? 0, cluster: clusterRank.get(find(id)) ?? 99 }));
  const maxW = Math.max(...nodes.map((n) => n.weight), 1);
  const radius = (n: Node) => 3 + 8 * Math.sqrt(n.weight / maxW);
  const maxE = Math.max(...edges.map((e) => e.value), 1);
  const simLinks = edges.map((e) => ({ ...e })) as unknown as Link[];

  const sim = forceSimulation<Node>(nodes)
    .force("link", forceLink<Node, any>(simLinks).id((d) => d.id).distance(48).strength((l: any) => 0.2 + 0.6 * (l.value / maxE)))
    .force("charge", forceManyBody().strength(-70).distanceMax(160))
    // A gentle pull to the middle: without it, small separate clusters drift
    // to the edges and fitting them all in shrinks the main one to a knot.
    .force("x", forceX(NW / 2).strength(0.06))
    .force("y", forceY(NH / 2).strength(0.1))
    .force("center", forceCenter(NW / 2, NH / 2))
    .force("collide", forceCollide<Node>().radius((n) => radius(n) + 2))
    .stop();
  for (let i = 0; i < 300; i++) sim.tick();

  // Groups in order of their weight, each its palette colour; else clusters.
  const groupWeight = new Map<string, number>();
  for (const n of nodes) { const g = groupOf.get(n.id); if (g) groupWeight.set(g, (groupWeight.get(g) ?? 0) + n.weight); }
  const groups = [...groupWeight].sort((a, b) => b[1] - a[1]).map(([g]) => g).slice(0, 8);
  const items = [
    ...(strongAt != null ? [{ key: "strong", label: ctx.text?.strong ?? "Strong link", fill: "hsl(var(--primary))", line: true }, { key: "weak", label: ctx.text?.weak ?? "By chance", fill: DEEMPHASIS_FILL, line: true }] : []),
    ...groups.map((g, i) => ({ key: g, label: g, fill: palette[i % palette.length]!, line: false })),
  ];
  const rows = items.length ? legendRows(items, NW - 12) : [];
  const legend = rows.flatMap((row, r) => {
    let x = 0;
    return row.map((i) => { const it = items[i]!; const at = x; x += legendItemWidth(it.label); return { ...it, x: at, row: r }; });
  });
  const legendH = rows.length ? rows.length * 14 + 6 : 0;

  // Fit what settled into the frame above the legend, leaving room for labels.
  const xs = nodes.map((n) => n.x ?? 0), ys = nodes.map((n) => n.y ?? 0);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const padX = 40, padY = 22;
  const h = NH - legendH;
  const kx = Math.min((NW - 2 * padX) / Math.max(1, x1 - x0), 4);
  const ky = Math.min((h - 2 * padY) / Math.max(1, y1 - y0), 4);
  for (const n of nodes) {
    n.x = padX + ((n.x ?? 0) - x0) * kx + ((NW - 2 * padX) - (x1 - x0) * kx) / 2;
    n.y = padY + ((n.y ?? 0) - y0) * ky + ((h - 2 * padY) - (y1 - y0) * ky) / 2;
  }
  const neighbours = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set<string>()]));
  for (const l of simLinks) { neighbours.get(l.source.id)!.add(l.target.id); neighbours.get(l.target.id)!.add(l.source.id); }
  return { nodes, links: simLinks, groupOf, groups, legend, legendH, radius, maxE, strongAt, neighbours };
}

/**
 * Pointing at a dot lights it, its links and the dots it links to, names them
 * all and fades the rest — which products a product is bought with, at a
 * glance. A dot can be dragged to pull a knot apart (zoom and pan come from
 * ChartZoom around every chart); a click without a drag still drills.
 */
function NetworkGraph({ ctx }: { ctx: ChartRenderCtx }) {
  const { xField, cfg, palette = DEFAULT_PALETTE, fmt, currency, handleClick, print } = ctx;
  const numOpts = { locale: ctx.dateStyle?.locale };
  const layout = useMemo(() => layoutNetwork(ctx),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx.data, ctx.xField, ctx.yFields.join("|"), JSON.stringify(ctx.cfg ?? {}), (ctx.palette ?? []).join("|"), ctx.text?.strong, ctx.text?.weak]);
  const [hover, setHover] = useState<string | null>(null);
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({});
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number; travelled: number; last: { x: number; y: number } } | null>(null);

  if (!layout) return empty(NW, NH, ctx.emptyText ?? "No links to show");
  const { nodes, links, groupOf, groups, legend, legendH, radius, maxE, strongAt, neighbours } = layout;
  const pos = (n: Node) => moved[n.id] ?? { x: n.x ?? 0, y: n.y ?? 0 };
  const colour = (n: Node) => groups.length
    ? (groups.includes(groupOf.get(n.id) ?? "") ? palette[groups.indexOf(groupOf.get(n.id)!) % palette.length]! : DEEMPHASIS_FILL)
    : n.cluster < 8 ? palette[n.cluster % palette.length]! : DEEMPHASIS_FILL;
  const isStrong = (l: Link) => strongAt != null && (l.strength ?? -Infinity) >= strongAt;
  const linkStroke = (l: Link) => (strongAt == null ? colour(l.source) : isStrong(l) ? "hsl(var(--primary))" : DEEMPHASIS_FILL);
  const linkOpacity = (l: Link) => (strongAt == null ? (l.source.cluster < 8 ? 0.55 : 0.35) : isStrong(l) ? 0.8 : 0.3);
  const strengthText = (l: Link) => (l.strength != null && cfg?.strengthField ? ` · ${seriesName(cfg.strengthField, cfg)} ${l.strength}` : "");
  const lit = hover ? new Set([hover, ...(neighbours.get(hover) ?? [])]) : null;
  // Names that fit: the pointed-at dot first, then the heaviest, each kept
  // only where it overlaps no name already placed — a hub's 17 neighbours
  // were printed over each other. The rest still name themselves on hover.
  const labelled = new Set<string>();
  {
    const placed: Array<[number, number, number, number]> = [];
    const wanted = (lit ? nodes.filter((n) => lit.has(n.id)) : nodes)
      .sort((a, b) => (a.id === hover ? -1 : b.id === hover ? 1 : b.weight - a.weight))
      .slice(0, lit ? 40 : 8);
    for (const n of wanted) {
      const p = pos(n), w = Math.min(n.id.length, hover ? 28 : 18) * 5.4, top = p.y - radius(n) - 13;
      const box: [number, number, number, number] = [p.x - w / 2, top, p.x + w / 2, top + 11];
      if (n.id !== hover && placed.some((q) => box[0] < q[2] && q[0] < box[2] && box[1] < q[3] && q[1] < box[3])) continue;
      placed.push(box);
      labelled.add(n.id);
    }
  }
  const touches = (l: Link) => !hover || l.source.id === hover || l.target.id === hover;

  // A point on screen in the svg's own units — right under ChartZoom's CSS scale too.
  const toSvg = (e: { clientX: number; clientY: number }) => {
    const m = svgRef.current?.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };

  return (
    <svg ref={svgRef} viewBox={`0 0 ${NW} ${NH}`} className="h-full max-h-full w-full max-w-full" onPointerLeave={() => { if (!drag.current) setHover(null); }}>
      <g>
        {links.map((l, i) => {
          const a = pos(l.source), b = pos(l.target);
          const on = touches(l);
          return (
            <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={linkStroke(l)} strokeOpacity={on ? (hover ? 0.95 : linkOpacity(l)) : 0.08}
              strokeWidth={(1 + 2.5 * (l.value / maxE)) * (hover && on ? 1.4 : 1)}>
              <desc className="chart-tip">{`${l.source.id} — ${l.target.id}: ${formatValue(l.value, fmt, currency, numOpts)}${strengthText(l)}`}</desc>
            </line>
          );
        })}
      </g>
      <g>
        {nodes.map((n) => {
          const p = pos(n);
          const on = !lit || lit.has(n.id);
          const focused = hover === n.id;
          return (
            <g key={n.id} style={{ cursor: print ? undefined : "grab" }} opacity={on ? 1 : 0.18}
              onPointerEnter={() => { if (!drag.current) setHover(n.id); }}
              onPointerDown={(e) => {
                if (print || e.button !== 0) return;
                e.stopPropagation(); // the dot moves, not the zoomed view
                const at = toSvg(e);
                drag.current = { id: n.id, dx: p.x - at.x, dy: p.y - at.y, travelled: 0, last: at };
                (e.currentTarget as Element).setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                const d = drag.current;
                if (!d || d.id !== n.id) return;
                const at = toSvg(e);
                d.travelled += Math.hypot(at.x - d.last.x, at.y - d.last.y);
                d.last = at;
                const x = Math.min(NW - 6, Math.max(6, at.x + d.dx));
                const y = Math.min(NH - legendH - 6, Math.max(6, at.y + d.dy));
                setMoved((m) => ({ ...m, [n.id]: { x, y } }));
              }}
              onPointerUp={() => {
                const d = drag.current;
                drag.current = null;
                // A press that didn't move is a click: drill, as before.
                if (d && d.travelled < 3) handleClick({ payload: { [xField]: n.id } });
              }}
            >
              <circle cx={p.x} cy={p.y} r={radius(n) * (focused ? 1.25 : 1)} fill={colour(n)}
                stroke={focused ? "hsl(var(--foreground))" : "hsl(var(--card))"} strokeWidth={focused ? 1.5 : 1}>
                <desc className="chart-tip">{`${n.id}: ${formatValue(n.weight, fmt, currency, numOpts)}${groupOf.get(n.id) ? `\n${groupOf.get(n.id)}` : ""}`}</desc>
              </circle>
              {labelled.has(n.id) && (
                <text x={p.x} y={p.y - radius(n) - 3} textAnchor="middle" fontSize={10} fontWeight={focused ? 600 : 400}
                  fill={focused ? "hsl(var(--foreground))" : LABEL_FILL} paintOrder="stroke" stroke="hsl(var(--card))" strokeWidth={3}
                  style={{ pointerEvents: "none" }}>
                  {clip(n.id, hover ? 28 : 18)}
                </text>
              )}
            </g>
          );
        })}
      </g>
      {legend.length > 0 && (
        // What the colours mean: strong against chance links, then the groups.
        <g transform={`translate(6,${NH - legendH + 12})`}>
          {legend.map((it) => (
            <g key={it.key} transform={`translate(${it.x},${it.row * 14})`}>
              {it.line ? <line x1={0} x2={10} y1={-4} y2={-4} stroke={it.fill} strokeWidth={2.5} /> : <circle cx={4} cy={-4} r={4} fill={it.fill} />}
              <text x={14} y={0} fontSize={9} fill={LABEL_FILL}>{clip(it.label, 18)}</text>
            </g>
          ))}
        </g>
      )}
    </svg>
  );
}

const CW = 460;
const CH = 300;
const MAX_GROUPS = 12;

export function renderChordChart(ctx: ChartRenderCtx): ReactElement {
  return <ChordChart ctx={ctx} />;
}

/**
 * Pointing at a group lights its ribbons — what it is bought with — and
 * fades the rest; a ribbon lights itself. Names sit level beside the ring
 * (radial names ran off the frame's top and bottom when enlarged, 2026-10-03).
 */
function ChordChart({ ctx }: { ctx: ChartRenderCtx }) {
  const { data, xField, yFields, cfg, palette = DEFAULT_PALETTE, fmt, currency, handleClick } = ctx;
  const numOpts = { locale: ctx.dateStyle?.locale };
  const [hover, setHover] = useState<{ group?: number; ribbon?: number } | null>(null);
  const edges = linksOf(data, xField, cfg?.targetField, yFields[0]!);
  if (edges.length === 0) return empty(CW, CH, ctx.emptyText ?? "No links to show");

  const total = new Map<string, number>();
  for (const e of edges) {
    total.set(e.source, (total.get(e.source) ?? 0) + e.value);
    total.set(e.target, (total.get(e.target) ?? 0) + e.value);
  }
  const names = [...total].sort((a, b) => b[1] - a[1]).slice(0, MAX_GROUPS).map(([n]) => n);
  const index = new Map(names.map((n, i) => [n, i]));
  const matrix = names.map(() => names.map(() => 0));
  for (const e of edges) {
    const i = index.get(e.source), j = index.get(e.target);
    if (i != null && j != null) matrix[i]![j]! += e.value;
  }
  // Directed: a group is sized by what flows in AND out. The undirected layout
  // sized it by outflow alone, so a group that only receives (deals by
  // source → segment: the segments) drew as a sliver.
  const chords = chordDirected().padAngle(0.04).sortSubgroups((a, b) => b - a)(matrix);
  const inner = 92, outer = 102;
  const groupArc = arc<any>().innerRadius(inner).outerRadius(outer);
  const ribbon = d3ribbon<any, any>().radius(inner - 1);
  const ribbonOn = (c: (typeof chords)[number], i: number) =>
    !hover || (hover.ribbon != null ? hover.ribbon === i : c.source.index === hover.group || c.target.index === hover.group);
  const groupOn = (g: number) =>
    !hover || (hover.group != null ? hover.group === g || chords.some((c) => (c.source.index === hover.group && c.target.index === g) || (c.target.index === hover.group && c.source.index === g))
      : chords[hover.ribbon!] != null && (chords[hover.ribbon!]!.source.index === g || chords[hover.ribbon!]!.target.index === g));

  return (
    <svg viewBox={`0 0 ${CW} ${CH}`} className="h-full max-h-full w-full max-w-full" onPointerLeave={() => setHover(null)}>
      <g transform={`translate(${CW / 2},${CH / 2})`}>
        <g>
          {chords.map((c, i) => (
            <path key={i} d={(ribbon(c as any) as unknown as string) ?? undefined} fill={palette[c.source.index % palette.length]}
              fillOpacity={ribbonOn(c, i) ? (hover ? 0.75 : 0.45) : 0.06} stroke={GRID_STROKE} strokeWidth={0.3}
              onPointerEnter={() => setHover({ ribbon: i })}>
              <desc className="chart-tip">{`${names[c.source.index]} → ${names[c.target.index]}: ${formatValue(c.source.value, fmt, currency, numOpts)}`}</desc>
            </path>
          ))}
        </g>
        {chords.groups.map((g) => {
          const mid = (g.startAngle + g.endAngle) / 2;
          const lr = outer + 8;
          const x = Math.sin(mid) * lr, y = -Math.cos(mid) * lr;
          // Level, on the ring's own side: right half starts at the ring, left half ends at it, top and bottom centre.
          const anchor = Math.abs(x) < 12 ? "middle" : x > 0 ? "start" : "end";
          const on = groupOn(g.index);
          return (
            <g key={g.index} onClick={() => handleClick({ payload: { [xField]: names[g.index] } })} onPointerEnter={() => setHover({ group: g.index })}
              style={{ cursor: "pointer" }} opacity={on ? 1 : 0.3}>
              <path d={groupArc(g) ?? undefined} fill={palette[g.index % palette.length]}>
                <desc className="chart-tip">{`${names[g.index]}: ${formatValue(g.value, fmt, currency, numOpts)}`}</desc>
              </path>
              <text x={x} y={y + (Math.abs(x) < 12 ? (y < 0 ? -2 : 8) : 0)} textAnchor={anchor} dominantBaseline="middle" fontSize={10}
                fontWeight={hover?.group === g.index ? 600 : 400} fill={hover?.group === g.index ? "hsl(var(--foreground))" : LABEL_FILL}>
                {clip(names[g.index]!, 18)}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}
