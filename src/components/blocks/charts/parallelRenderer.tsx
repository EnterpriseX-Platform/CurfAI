"use client";
/**
 * Parallel axes — every row across several measures at once, one line each.
 * yFields are the axes (2-7 numeric columns, each scaled to its own
 * min-max), xField the category a line is coloured by: the six largest
 * categories in the palette, the rest receding. For spotting the rows that
 * are off on several checks at once — a budget request high on cost, low on
 * readiness and slow to move. Hand-drawn SVG, rendered OUTSIDE ChartBlock's
 * ResponsiveContainer like the Sankey; reads the raw rows its query returns.
 *
 * Drag along an axis to keep only the rows inside that range — on several
 * axes at once, a row has to pass every one. The rest fade; the count of
 * rows that match shows in the corner. Click an axis without dragging to
 * clear it. A print shows every row, no ranges.
 */
import { useRef, useState, type ReactElement, type PointerEvent as ReactPointerEvent } from "react";
import { formatMetricCompact } from "@/lib/reporting/format";
import { DEFAULT_PALETTE, DEEMPHASIS_FILL, GRID_STROKE, LABEL_FILL, seriesName, type ChartRenderCtx } from "./shared";

// Wide: parallel axes are laid out full width (layoutVisuals), so the frame is too.
const W = 720;
const H = 290;
const MAX_ROWS = 2500;
const MAX_AXES = 7;
const COLOURED = 6;
const TOP = 30, BOTTOM = H - 48, LEFT = 40, RIGHT = W - 40;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Keep the rows inside every brushed range (value bounds per axis). */
export function rowsInRanges(rows: Array<Record<string, unknown>>, ranges: Record<string, [number, number]>): Set<number> {
  const keep = new Set<number>();
  rows.forEach((r, i) => {
    for (const [f, [lo, hi]] of Object.entries(ranges)) {
      const v = Number(r?.[f]);
      if (!(r?.[f] != null && Number.isFinite(v) && v >= lo && v <= hi)) return;
    }
    keep.add(i);
  });
  return keep;
}

export function renderParallelChart(ctx: ChartRenderCtx): ReactElement {
  return <ParallelAxes ctx={ctx} />;
}

function ParallelAxes({ ctx }: { ctx: ChartRenderCtx }) {
  const { data, xField, yFields, cfg, palette = DEFAULT_PALETTE, fmt, currency, handleClick, print } = ctx;
  const numOpts = { locale: ctx.dateStyle?.locale };
  const svg = useRef<SVGSVGElement>(null);
  const [ranges, setRanges] = useState<Record<string, [number, number]>>({});
  const [drag, setDrag] = useState<{ axis: number; y0: number; y1: number } | null>(null);

  const rows = (data as Array<Record<string, unknown>>).slice(0, MAX_ROWS);
  const axes = yFields.filter((f) => rows.some((r) => Number.isFinite(Number(r?.[f])) && r?.[f] != null)).slice(0, MAX_AXES);
  if (rows.length === 0 || axes.length < 2) {
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="h-full max-h-full w-full max-w-full">
        <text x={W / 2} y={H / 2} textAnchor="middle" fontSize={11} fill={LABEL_FILL}>{ctx.emptyText ?? "No rows to show"}</text>
      </svg>
    );
  }
  const range = axes.map((f) => {
    const vals = rows.map((r) => Number(r?.[f])).filter(Number.isFinite);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    return (lo === hi ? [lo - 1, hi + 1] : [lo, hi]) as [number, number];
  });
  const counts = new Map<string, number>();
  for (const r of rows) { const k = String(r?.[xField] ?? "—"); counts.set(k, (counts.get(k) ?? 0) + 1); }
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, COLOURED).map(([k]) => k);
  const colourOf = (k: string) => { const i = top.indexOf(k); return i >= 0 ? palette[i % palette.length]! : DEEMPHASIS_FILL; };

  const ax = (i: number) => LEFT + ((RIGHT - LEFT) * i) / (axes.length - 1);
  const ay = (i: number, v: number) => BOTTOM - ((v - range[i]![0]) / (range[i]![1] - range[i]![0])) * (BOTTOM - TOP);
  const valueAt = (i: number, y: number) => range[i]![0] + ((BOTTOM - y) / (BOTTOM - TOP)) * (range[i]![1] - range[i]![0]);
  const short = (v: number) => formatMetricCompact(v, fmt, currency, numOpts.locale);

  const active = Object.keys(ranges).length > 0;
  const keep = active ? rowsInRanges(rows, ranges) : null;
  const opacity = rows.length > 1000 ? 0.18 : rows.length > 200 ? 0.25 : rows.length > 60 ? 0.4 : 0.65;

  // Pointer y in the SVG's own units, held to the axis.
  const svgY = (e: ReactPointerEvent) => {
    const el = svg.current; if (!el) return TOP;
    const pt = el.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const m = el.getScreenCTM(); if (!m) return TOP;
    return Math.min(BOTTOM, Math.max(TOP, pt.matrixTransform(m.inverse()).y));
  };
  const finish = () => {
    if (!drag) return;
    const f = axes[drag.axis]!;
    const [a, b] = [drag.y0, drag.y1].sort((p, q) => p - q);
    setRanges((cur) => {
      const next = { ...cur };
      // A click without a drag clears that axis.
      if (b! - a! < 4) delete next[f];
      else next[f] = [valueAt(drag.axis, b!), valueAt(drag.axis, a!)];
      return next;
    });
    setDrag(null);
  };

  // Faded lines first, then the coloured, then the ones inside every range.
  const order = rows
    .map((r, i) => ({ r, i, rank: (keep ? (keep.has(i) ? 2 : 0) : 1) + (top.includes(String(r?.[xField])) ? 0.5 : 0) }))
    .sort((p, q) => p.rank - q.rank);
  return (
    <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="h-full max-h-full w-full max-w-full select-none"
      onPointerMove={(e) => { if (drag) setDrag({ ...drag, y1: svgY(e) }); }} onPointerUp={finish} onPointerLeave={finish}>
      {active && (
        <text x={W - 6} y={12} textAnchor="end" fontSize={11} fontWeight={600} fill="hsl(var(--foreground))">
          {`${keep!.size.toLocaleString()} / ${rows.length.toLocaleString()}`}
        </text>
      )}
      <g fill="none">
        {order.map(({ r, i }) => {
          const pts = axes.map((f, a) => { const v = Number(r?.[f]); return Number.isFinite(v) && r?.[f] != null ? `${ax(a)},${ay(a, v)}` : null; });
          if (pts.some((p) => p == null)) return null;
          const k = String(r?.[xField] ?? "—");
          const out = keep ? !keep.has(i) : false;
          return (
            <polyline key={i} points={pts.join(" ")} stroke={out ? DEEMPHASIS_FILL : colourOf(k)}
              strokeOpacity={out ? 0.08 : keep ? Math.min(0.9, opacity * 2.5) : opacity} strokeWidth={1}
              onClick={() => handleClick({ payload: { [xField]: r?.[xField] } })} style={{ cursor: "pointer" }}>
              <desc className="chart-tip">{`${k}\n${axes.map((f) => `${seriesName(f, cfg)}: ${short(Number(r?.[f]))}`).join("\n")}`}</desc>
            </polyline>
          );
        })}
      </g>
      {axes.map((f, i) => {
        const brushed = ranges[f];
        const dragging = drag?.axis === i;
        return (
          <g key={f}>
            <line x1={ax(i)} x2={ax(i)} y1={TOP} y2={BOTTOM} stroke={GRID_STROKE} strokeWidth={1.2} />
            {/* The outer axes' names lean inward: centred, the last one ran off the frame. */}
            <text x={ax(i)} y={TOP - 16} textAnchor={i === 0 && axes.length > 1 ? "start" : i === axes.length - 1 && axes.length > 1 ? "end" : "middle"} fontSize={10} fontWeight={600} fill="hsl(var(--foreground))">{clip(seriesName(f, cfg), 18)}</text>
            <text x={ax(i)} y={TOP - 5} textAnchor="middle" fontSize={9} fill={LABEL_FILL}>{short(range[i]![1])}</text>
            <text x={ax(i)} y={BOTTOM + 12} textAnchor="middle" fontSize={9} fill={LABEL_FILL}>{short(range[i]![0])}</text>
            {brushed && !dragging && (
              <rect x={ax(i) - 7} y={ay(i, brushed[1])} width={14} height={Math.max(2, ay(i, brushed[0]) - ay(i, brushed[1]))}
                rx={3} fill="hsl(var(--primary) / 0.18)" stroke="hsl(var(--primary))" strokeWidth={1} pointerEvents="none" />
            )}
            {dragging && (
              <rect x={ax(i) - 7} y={Math.min(drag!.y0, drag!.y1)} width={14} height={Math.abs(drag!.y1 - drag!.y0)}
                rx={3} fill="hsl(var(--primary) / 0.18)" stroke="hsl(var(--primary))" strokeWidth={1} pointerEvents="none" />
            )}
            {!print && (
              // The grab strip: a wide invisible target along the axis.
              <rect x={ax(i) - 12} y={TOP} width={24} height={BOTTOM - TOP} fill="transparent" style={{ cursor: "ns-resize" }}
                onPointerDown={(e) => { const y = svgY(e); setDrag({ axis: i, y0: y, y1: y }); }} />
            )}
          </g>
        );
      })}
      <g transform={`translate(${LEFT},${H - 14})`}>
        {top.map((k, i) => (
          <g key={k} transform={`translate(${i * ((RIGHT - LEFT) / COLOURED)},0)`}>
            <rect width={8} height={8} y={-7} rx={2} fill={colourOf(k)} />
            <text x={11} y={0} fontSize={9} fill={LABEL_FILL}>{clip(`${k} ${counts.get(k)!.toLocaleString()}`, 20)}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}
