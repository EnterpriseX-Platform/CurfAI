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
      {/* 176 tall: the min/max labels sit under the arc's ends (y ≈ 169), which a 160 frame cut off. */}
      <svg viewBox="0 0 200 176" className="h-full max-h-full w-full max-w-full">
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
          textAnchor="middle" fontSize={10} fill={TICK_FILL}
        >
          {format(min)}
        </text>
        <text
          x={cx + r * Math.cos((endAngle * Math.PI) / 180)}
          y={cy + r * Math.sin((endAngle * Math.PI) / 180) + 14}
          textAnchor="middle" fontSize={10} fill={TICK_FILL}
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
 * beneath each visible delta. Total rows (a label starting "Total" /
 * "Subtotal", or the Thai and Chinese words for it — รวม, ยอดรวม, 合计,
 * 总计, 小计 — since a report's labels are in its reader's language) draw
 * from zero in a distinct accent color.
 *
 * Output row shape:
 *   { ...row, __base, __bar, __delta, __kind }
 */
const WATERFALL_TOTAL = /^\s*((sub)?total\b|ยอดรวม|รวม|合计|总计|小计)/i;

const OPENING = /ทั้งหมด|ยกมา|เริ่มต้น|ตั้งต้น|เดือนก่อน|ปีก่อน|\b(opening|start(ing)?|begin(ning)?|previous|prior|last (month|year|quarter))\b|期初|上期/i;

export function buildWaterfall(rows: any[], xField: string, yField: string) {
  let running = 0;
  let started = false;
  // A bridge that closes on a total opens on one: "ยอดขาย 1–29 ส.ค." before the
  // branches' changes and "รวม 1–29 ก.ย." was drawn as a +฿11.9M gain.
  const closesOnTotal = rows.length > 2 && WATERFALL_TOTAL.test(String(rows[rows.length - 1]?.[xField] ?? ""));
  return rows.map((r, i) => {
    const label = String(r?.[xField] ?? "");
    const isTotal = WATERFALL_TOTAL.test(label);
    const delta = Number(r?.[yField]);
    if (!Number.isFinite(delta)) {
      return { ...r, __base: 0, __bar: 0, __delta: 0, __kind: "delta" as const };
    }
    // A total before any change is the opening balance ("รวมเดือนก่อน" — last
    // month's total): its own value, which the steps then start from. Read as
    // a running total it was the 0 that had accumulated so far.
    // So is a first row whose label names a level, not a change: "วงเงินที่ขอ
    // ทั้งหมด" (all requested), "ยอดยกมา", "opening", "previous month" — the
    // budget bureau's bridge opened on a green "+20.4 พันล." as if it were a gain.
    if (!started && (OPENING.test(label) || (closesOnTotal && i === 0))) {
      started = true;
      running = delta;
      return { ...r, __base: 0, __bar: delta, __delta: delta, __kind: "total" as const };
    }
    if (isTotal && !started) {
      started = true;
      running = delta;
      return { ...r, __base: 0, __bar: delta, __delta: delta, __kind: "total" as const };
    }
    started = true;
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
