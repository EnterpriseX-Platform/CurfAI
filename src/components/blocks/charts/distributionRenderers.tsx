"use client";
/**
 * Box plot and radial — how a measure spreads, rather than how much of it
 * there is. Hand-drawn SVG in the same fixed-viewBox-scaled-by-CSS pattern
 * as sankeyRenderer.tsx, rendered OUTSIDE ChartBlock's ResponsiveContainer.
 *
 * Box plot: one box per xField value over the RAW rows its query returns
 * (median, quartiles, whiskers at 1.5×IQR, the rest as outlier dots) — the
 * statistics are computed here because neither lake engine has a portable
 * percentile function. Radial: yFields[0] per xField bucket round a circle,
 * in the order the query returns them (hours 0-23, weekdays, months), so a
 * day's busy and quiet stretches read as a clock face.
 *
 * Neither wires reference lines or annotations: there is no Cartesian axis
 * for a Reference* element to anchor to (same as Sankey/Sunburst).
 */
import { useState, type ReactElement } from "react";
import { arc } from "d3-shape";
import { formatMetricCompact } from "@/lib/reporting/format";
import { DEFAULT_PALETTE, DEEMPHASIS_FILL, GRID_STROKE, LABEL_FILL, formatValue, seriesName, type ChartRenderCtx } from "./shared";

// Drawn half width as often as full: text is sized to stay readable at half.
const W = 440;
const H = 260;
const MAX_GROUPS = 20;
const MAX_OUTLIERS = 40;

function empty(text: string): ReactElement {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full max-h-full w-full max-w-full">
      <text x={W / 2} y={H / 2} textAnchor="middle" fontSize={11} fill={LABEL_FILL}>{text}</text>
    </svg>
  );
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Linear-interpolated quantile of a sorted array (the "type 7" definition spreadsheets use). */
export function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

export type BoxStats = { name: string; n: number; q1: number; median: number; q3: number; lo: number; hi: number; outliers: number[] };

/** One box per group, in first-seen order: quartiles, whiskers at 1.5×IQR, the rest outliers. */
export function boxStats(data: unknown[], xField: string, yField: string): BoxStats[] {
  const groups = new Map<string, number[]>();
  for (const row of data as Array<Record<string, unknown>>) {
    const v = Number(row?.[yField]);
    if (row?.[yField] == null || !Number.isFinite(v)) continue;
    const k = String(row?.[xField] ?? "—");
    if (!groups.has(k)) {
      if (groups.size >= MAX_GROUPS) continue;
      groups.set(k, []);
    }
    groups.get(k)!.push(v);
  }
  return [...groups].map(([name, vals]) => {
    const s = vals.sort((a, b) => a - b);
    const q1 = quantile(s, 0.25), median = quantile(s, 0.5), q3 = quantile(s, 0.75);
    const iqr = q3 - q1;
    const inside = s.filter((v) => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr);
    return { name, n: s.length, q1, median, q3, lo: inside[0] ?? q1, hi: inside[inside.length - 1] ?? q3, outliers: s.filter((v) => v < q1 - 1.5 * iqr || v > q3 + 1.5 * iqr) };
  });
}

export function renderBoxPlotChart(ctx: ChartRenderCtx): ReactElement {
  const { data, xField, yFields, cfg, palette = DEFAULT_PALETTE, fmt, currency, handleClick } = ctx;
  const numOpts = { locale: ctx.dateStyle?.locale };
  // Lying down, one row per category, widest-spread reading order: the
  // category names have room on the left whatever their length, and the
  // chart grows a row per category instead of squeezing them.
  const boxes = boxStats(data, xField, yFields[0]!).sort((p, q) => q.median - p.median);
  if (boxes.length === 0) return empty(ctx.emptyText ?? "No rows to show");
  const refs: Array<{ value: number; label?: string }> = (cfg?.referenceLines ?? []).filter((r: any) => Number.isFinite(Number(r?.value)));

  const all = [...boxes.flatMap((b) => [b.lo, b.hi, ...b.outliers.slice(0, MAX_OUTLIERS)]), ...refs.map((r) => Number(r.value))];
  let min = Math.min(...all), max = Math.max(...all);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.05;
  min -= pad; max += pad;
  const ROW = 22;
  const left = 132, right = W - 14, top = 22, height = top + boxes.length * ROW + 10;
  const x = (v: number) => left + ((v - min) / (max - min)) * (right - left);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => min + (max - min) * f);
  const short = (v: number) => formatMetricCompact(v, fmt, currency, numOpts.locale);
  const fill = palette[0]!;
  const high = "hsl(var(--destructive))";

  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="h-full max-h-full w-full max-w-full" preserveAspectRatio="xMidYMin meet">
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={x(t)} x2={x(t)} y1={top - 4} y2={height - 8} stroke={GRID_STROKE} strokeWidth={0.5} />
          <text x={x(t)} y={top - 9} textAnchor={i === ticks.length - 1 ? "end" : "middle"} fontSize={10} fill={LABEL_FILL}>{short(t)}</text>
        </g>
      ))}
      {refs.map((r, i) => (
        <g key={`ref${i}`}>
          <line x1={x(Number(r.value))} x2={x(Number(r.value))} y1={top - 4} y2={height - 8} stroke={fill} strokeWidth={1.2} strokeDasharray="4 3" />
          {r.label && <text x={x(Number(r.value)) + 4} y={height - 10} fontSize={9} fill={fill}>{r.label}</text>}
        </g>
      ))}
      {boxes.map((b, i) => {
        const cy = top + ROW * (i + 0.5);
        const bh = ROW * 0.55;
        return (
          <g key={b.name} onClick={() => handleClick({ payload: { [xField]: b.name } })} style={{ cursor: "pointer" }}>
            <desc className="chart-tip">{`${b.name} · n ${b.n.toLocaleString()}\nmedian ${formatValue(b.median, fmt, currency, numOpts)}\nQ1–Q3 ${formatValue(b.q1, fmt, currency, numOpts)} – ${formatValue(b.q3, fmt, currency, numOpts)}\nrange ${formatValue(b.lo, fmt, currency, numOpts)} – ${formatValue(b.hi, fmt, currency, numOpts)}${b.outliers.length ? `\noutliers ${b.outliers.length}` : ""}`}</desc>
            <rect x={0} y={cy - ROW / 2} width={W} height={ROW} fill="transparent" />
            <text x={left - 8} y={cy} textAnchor="end" dominantBaseline="middle" fontSize={10.5} fill="hsl(var(--foreground))">{clip(b.name, 20)}</text>
            <line x1={x(b.lo)} x2={x(b.q1)} y1={cy} y2={cy} stroke={fill} strokeWidth={1} />
            <line x1={x(b.q3)} x2={x(b.hi)} y1={cy} y2={cy} stroke={fill} strokeWidth={1} />
            <line x1={x(b.lo)} x2={x(b.lo)} y1={cy - bh / 3} y2={cy + bh / 3} stroke={fill} strokeWidth={1} />
            <line x1={x(b.hi)} x2={x(b.hi)} y1={cy - bh / 3} y2={cy + bh / 3} stroke={fill} strokeWidth={1} />
            <rect x={x(b.q1)} y={cy - bh / 2} width={Math.max(1, x(b.q3) - x(b.q1))} height={bh} rx={3} fill={fill} fillOpacity={0.18} stroke={fill} strokeWidth={1} />
            <line x1={x(b.median)} x2={x(b.median)} y1={cy - bh / 2} y2={cy + bh / 2} stroke={fill} strokeWidth={2} />
            {b.outliers.slice(0, MAX_OUTLIERS).map((o, j) => (
              // High outliers — the costly ones — in the alarm colour; low ones recede.
              <circle key={j} cx={x(o)} cy={cy} r={2.6} fill={o > b.q3 ? high : DEEMPHASIS_FILL} fillOpacity={0.85} />
            ))}
          </g>
        );
      })}
    </svg>
  );
}

const RW = 420;
const RH = 260;

export function renderRadialChart(ctx: ChartRenderCtx): ReactElement {
  return <RadialChart ctx={ctx} />;
}

/**
 * Pointing at a slot lights it and fades the rest, and the middle reads that
 * slot out — its hour, its total and each measure — so the day can be read
 * hour by hour without chasing a tooltip. At rest the middle names the peak.
 */
function RadialChart({ ctx }: { ctx: ChartRenderCtx }) {
  const { data, xField, yFields, cfg, palette = DEFAULT_PALETTE, fmt, currency, handleClick } = ctx;
  const numOpts = { locale: ctx.dateStyle?.locale };
  const [hover, setHover] = useState<number | null>(null);
  // Several measures stack outward in each slot — store, then online — each
  // in its own colour; one measure shades by size, as before.
  const series = yFields.slice(0, 4);
  const stacked = series.length > 1;
  const totals = new Map<string, number[]>();
  for (const row of data as Array<Record<string, unknown>>) {
    const k = String(row?.[xField] ?? "—");
    const cur = totals.get(k) ?? series.map(() => 0);
    series.forEach((f, j) => { const v = Number(row?.[f]); if (Number.isFinite(v)) cur[j] += v; });
    totals.set(k, cur);
  }
  const buckets = [...totals].slice(0, 60).map(([k, vs]) => [k, vs, vs.reduce((a, b) => a + Math.max(0, b), 0)] as const);
  if (buckets.length === 0) return empty(ctx.emptyText ?? "No rows to show");

  const cx = RW / 2, cy = RH / 2, inner = 34, outer = 104;
  const max = Math.max(...buckets.map(([, , t]) => t), 1);
  // Hours of the day sit on a 24-hour face, closed hours left empty — the
  // shape of the day, not just its open hours spread round the circle.
  const hours = buckets.length <= 24 && buckets.every(([k]) => /^\d{1,2}$/.test(k) && Number(k) <= 23);
  const slots = hours ? 24 : buckets.length;
  const slotOf = (i: number) => (hours ? Number(buckets[i]![0]) : i);
  const step = (2 * Math.PI) / slots;
  const padAngle = Math.min(0.03, step * 0.15);
  const peakIndex = buckets.reduce((best, b, i) => (b[2] > buckets[best]![2] ? i : best), 0);
  const path = arc<{ innerRadius: number; outerRadius: number; startAngle: number; endAngle: number }>();
  const labelEvery = buckets.length > 24 ? Math.ceil(buckets.length / 12) : 1;
  const rOf = (v: number) => inner + (outer - inner) * (Math.max(0, v) / max);
  // An hour reads as one ("18:00"); anything else as itself.
  const slotName = (name: string) => (hours ? `${name.padStart(2, "0")}:00` : name);
  const shown = hover ?? peakIndex;
  const [shownName, shownVs, shownTotal] = buckets[shown]!;

  return (
    <svg viewBox={`0 0 ${RW} ${RH}`} className="h-full max-h-full w-full max-w-full" onPointerLeave={() => setHover(null)}>
      <g transform={`translate(${cx},${cy})`}>
        {[0.5, 1].map((f) => (
          <circle key={f} r={inner + (outer - inner) * f} fill="none" stroke={GRID_STROKE} strokeWidth={0.5} />
        ))}
        {buckets.map(([name, vs, total], i) => {
          const a0 = slotOf(i) * step + padAngle, a1 = (slotOf(i) + 1) * step - padAngle;
          const mid = (a0 + a1) / 2;
          const lr = outer + 10;
          const tip = stacked
            ? `${slotName(name)}\n${series.map((f, j) => `${seriesName(f, cfg)}: ${formatValue(vs[j]!, fmt, currency, numOpts)}`).join("\n")}`
            : `${slotName(name)}: ${formatValue(vs[0]!, fmt, currency, numOpts)}`;
          const faded = hover != null && hover !== i;
          let run = 0;
          return (
            <g key={name} onClick={() => handleClick({ payload: { [xField]: name } })} onPointerEnter={() => setHover(i)}
              style={{ cursor: "pointer" }} opacity={faded ? 0.3 : 1}>
              {/* The whole slot answers the pointer, empty hours too — not only its bars. */}
              <path d={path({ innerRadius: inner - 4, outerRadius: outer + 4, startAngle: a0 - padAngle, endAngle: a1 + padAngle }) ?? undefined} fill="transparent" />
              {series.map((f, j) => {
                const v = Math.max(0, vs[j]!);
                const r0 = rOf(run), r1 = rOf(run + v);
                run += v;
                return (
                  <path key={f}
                    d={path({ innerRadius: r0, outerRadius: Math.max(r0 + 0.5, r1), startAngle: a0, endAngle: a1 }) ?? undefined}
                    fill={palette[j % palette.length]} fillOpacity={stacked ? 0.85 : 0.3 + 0.7 * (total / max)}
                  >
                    <desc className="chart-tip">{tip}</desc>
                  </path>
                );
              })}
              {i % labelEvery === 0 && (
                <text x={Math.sin(mid) * lr} y={-Math.cos(mid) * lr} textAnchor="middle" dominantBaseline="middle" fontSize={10}
                  fontWeight={hover === i ? 600 : 400} fill={hover === i ? "hsl(var(--foreground))" : LABEL_FILL}>
                  {clip(name, 8)}
                </text>
              )}
            </g>
          );
        })}
        {/* The middle: the slot pointed at, else the peak. */}
        <g style={{ pointerEvents: "none" }}>
          <text y={stacked ? -14 : -8} textAnchor="middle" fontSize={9} fill={LABEL_FILL}>
            {hover == null ? `${ctx.text?.peak ?? "Peak"} ${clip(slotName(shownName), 10)}` : clip(slotName(shownName), 12)}
          </text>
          <text y={stacked ? 1 : 7} textAnchor="middle" fontSize={12} fontWeight={600} fill="hsl(var(--foreground))">
            {formatMetricCompact(shownTotal, fmt, currency, numOpts.locale)}
          </text>
          {stacked && series.slice(0, 2).map((f, j) => (
            <text key={f} y={13 + j * 10} textAnchor="middle" fontSize={8} fill={palette[j % palette.length]}>
              {formatMetricCompact(shownVs[j]!, fmt, currency, numOpts.locale)}
            </text>
          ))}
        </g>
      </g>
      {stacked && (
        <g transform={`translate(8,${RH - 8 - series.length * 13})`}>
          {series.map((f, j) => (
            <g key={f} transform={`translate(0,${j * 13})`}>
              <rect width={9} height={9} rx={2} fill={palette[j % palette.length]} />
              <text x={13} y={8} fontSize={10} fill={LABEL_FILL}>{clip(seriesName(f, cfg), 18)}</text>
            </g>
          ))}
        </g>
      )}
    </svg>
  );
}
