/**
 * Gauge & Bullet chart components — Tier 2.4 / 2.1 of the viz roadmap.
 *
 * Extracted from ChartBlock.tsx to keep that file lean. Both are pure-SVG
 * renderers (no Recharts) because the polar/zoned geometry is awkward to
 * build with RadialBarChart and these are simple enough to hand-draw.
 *
 * Shared config: min/max/target/zones[]. The gauge draws a 240° arc with
 * value over track; the bullet draws a horizontal bar with target tick.
 */
import { TICK_FILL } from "./shared";

/** Light-tint a theme semantic color for zone backgrounds — same pattern as MapBlock/HeatmapBlock's colorMix(). */
function zoneTint(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},0.35)`;
}

export type GaugeZone = {
  upTo: number;
  color: "danger" | "warning" | "success" | "info" | "neutral";
};

export function GaugeChart({
  value, min, max, target, zones, palette, format, semantic,
}: {
  value: number;
  min: number;
  max: number;
  target?: number;
  zones?: GaugeZone[];
  palette: string[];
  format: (v: number) => string;
  /** Theme semantic tokens (theme.semantic) — zones tint from these, not a fixed pastel map. */
  semantic: Record<string, string>;
}) {
  const safe = Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
  const span = max - min || 1;
  // Arc spans -210°..+30° = 240° sweep, gap at the bottom for labels.
  const startAngle = -210;
  const endAngle = 30;
  const angle = (t: number) =>
    startAngle + (endAngle - startAngle) * Math.max(0, Math.min(1, (t - min) / span));
  const r = 90;
  const cx = 100;
  const cy = 110;
  const arcPath = (a0: number, a1: number) => {
    const rad = (a: number) => (a * Math.PI) / 180;
    const x0 = cx + r * Math.cos(rad(a0));
    const y0 = cy + r * Math.sin(rad(a0));
    const x1 = cx + r * Math.cos(rad(a1));
    const y1 = cy + r * Math.sin(rad(a1));
    const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
    const sweep = a1 > a0 ? 1 : 0;
    return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${large} ${sweep} ${x1.toFixed(2)},${y1.toFixed(2)}`;
  };

  return (
    <div className="flex h-full w-full items-center justify-center">
      <svg viewBox="0 0 200 160" className="h-full max-h-full w-full max-w-full">
        {zones && zones.length > 0 ? (
          (() => {
            const sorted = [...zones].sort((a, b) => a.upTo - b.upTo);
            let prev = min;
            return sorted.map((z, i) => {
              const a0 = angle(prev);
              const a1 = angle(z.upTo);
              prev = z.upTo;
              return (
                <path
                  key={i}
                  d={arcPath(a0, a1)}
                  stroke={zoneTint(semantic[z.color] ?? semantic.neutral)}
                  strokeWidth={18}
                  strokeLinecap="butt"
                  fill="none"
                />
              );
            });
          })()
        ) : (
          <path
            d={arcPath(startAngle, endAngle)}
            stroke="#e5e7eb"
            strokeWidth={18}
            strokeLinecap="round"
            fill="none"
          />
        )}
        {Number.isFinite(safe) && (
          <path
            d={arcPath(startAngle, angle(safe))}
            stroke={palette[0]}
            strokeWidth={18}
            strokeLinecap="round"
            fill="none"
          />
        )}
        {target !== undefined && Number.isFinite(target) && target >= min && target <= max &&
          (() => {
            const a = (angle(target) * Math.PI) / 180;
            const ix = cx + (r - 14) * Math.cos(a);
            const iy = cy + (r - 14) * Math.sin(a);
            const ox = cx + (r + 14) * Math.cos(a);
            const oy = cy + (r + 14) * Math.sin(a);
            return (
              <line
                x1={ix.toFixed(2)} y1={iy.toFixed(2)}
                x2={ox.toFixed(2)} y2={oy.toFixed(2)}
                stroke="#0f172a" strokeWidth={2.5} strokeLinecap="round"
              />
            );
          })()}
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize={26} fontWeight={700} fill="#0f172a">
          {format(value)}
        </text>
        {target !== undefined && Number.isFinite(target) && (
          <text x={cx} y={cy + 16} textAnchor="middle" fontSize={10} fill="#64748b">
            target {format(target)}
          </text>
        )}
        <text
          x={cx + r * Math.cos((startAngle * Math.PI) / 180)}
          y={cy + r * Math.sin((startAngle * Math.PI) / 180) + 14}
          textAnchor="end" fontSize={10} fill={TICK_FILL}
        >
          {format(min)}
        </text>
        <text
          x={cx + r * Math.cos((endAngle * Math.PI) / 180)}
          y={cy + r * Math.sin((endAngle * Math.PI) / 180) + 14}
          textAnchor="start" fontSize={10} fill={TICK_FILL}
        >
          {format(max)}
        </text>
      </svg>
    </div>
  );
}

export function BulletChart({
  value, min, max, target, zones, palette, format, label, semantic,
}: {
  value: number;
  min: number;
  max: number;
  target?: number;
  zones?: GaugeZone[];
  palette: string[];
  format: (v: number) => string;
  label?: string;
  /** Theme semantic tokens (theme.semantic) — zones tint from these, not a fixed pastel map. */
  semantic: Record<string, string>;
}) {
  const safe = Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
  const span = max - min || 1;
  const pos = (t: number) => ((t - min) / span) * 100;
  return (
    <div className="flex h-full w-full flex-col justify-center gap-3 px-4">
      {label && <div className="text-xs font-medium text-muted-foreground">{label}</div>}
      <div className="relative h-9 w-full">
        <div className="absolute inset-0 overflow-hidden rounded">
          {zones && zones.length > 0 ? (
            (() => {
              const sorted = [...zones].sort((a, b) => a.upTo - b.upTo);
              let prev = min;
              return sorted.map((z, i) => {
                const left = pos(prev);
                const right = pos(z.upTo);
                prev = z.upTo;
                return (
                  <span
                    key={i}
                    className="absolute inset-y-0"
                    style={{ left: `${left}%`, width: `${right - left}%`, background: zoneTint(semantic[z.color] ?? semantic.neutral) }}
                  />
                );
              });
            })()
          ) : (
            <span className="absolute inset-0 bg-muted" />
          )}
        </div>
        <div
          className="absolute inset-y-2 left-0 rounded"
          style={{ width: `${pos(safe)}%`, background: palette[0] }}
        />
        {target !== undefined && Number.isFinite(target) && target >= min && target <= max && (
          <div
            className="absolute -inset-y-1 w-[3px] rounded bg-foreground"
            style={{ left: `calc(${pos(target)}% - 1.5px)` }}
            title={`target ${format(target)}`}
          />
        )}
      </div>
      <div className="flex items-baseline justify-between text-[11px] tabular-nums text-muted-foreground">
        <span>{format(min)}</span>
        <span className="text-xl font-semibold tabular-nums text-foreground">{format(value)}</span>
        <span>{format(max)}</span>
      </div>
    </div>
  );
}

/**
 * Resolve gauge/bullet min/max bounds. Authors can hard-set via
 * cfg.gaugeMin / gaugeMax; otherwise we infer from the dataset (0..max).
 * Falls back to 0..100 for empty datasets.
 */
export function computeGaugeBounds(
  data: any[],
  yField: string,
  cfg: { gaugeMin?: number; gaugeMax?: number },
): { min: number; max: number } {
  let min = cfg.gaugeMin;
  let max = cfg.gaugeMax;
  if (min === undefined || max === undefined) {
    const nums = data.map((r) => Number(r?.[yField])).filter((n) => Number.isFinite(n));
    const dataMax = nums.length ? Math.max(...nums) : 100;
    if (min === undefined) min = 0;
    if (max === undefined) max = Math.max(dataMax, 1);
  }
  if (min === max) max = min + 1;
  return { min, max };
}

/**
 * Waterfall data transformer (Tier 2.3 — viz.chart.waterfall).
 *
 * Walks rows in declared order, computes a running total, and emits the
 * shape needed for a Recharts stacked BarChart with a transparent spacer
 * beneath each visible delta. Total rows (label matches /^total/i) draw
 * from zero in a distinct accent color.
 *
 * Output row shape:
 *   { ...row, __base, __bar, __delta, __kind }
 */
export function buildWaterfall(rows: any[], xField: string, yField: string) {
  let running = 0;
  return rows.map((r) => {
    const label = String(r?.[xField] ?? "");
    const isTotal = /^\s*(sub)?total\b/i.test(label);
    const delta = Number(r?.[yField]);
    if (!Number.isFinite(delta)) {
      return { ...r, __base: 0, __bar: 0, __delta: 0, __kind: "delta" as const };
    }
    if (isTotal) {
      const total = running;
      return { ...r, __base: 0, __bar: total, __delta: total, __kind: "total" as const };
    }
    let base: number;
    let bar: number;
    if (delta >= 0) {
      base = running;
      bar = delta;
      running += delta;
    } else {
      running += delta;
      base = running;
      bar = -delta;
    }
    return { ...r, __base: base, __bar: bar, __delta: delta, __kind: "delta" as const };
  });
}
