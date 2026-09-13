"use client";
import { useMemo } from "react";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/reporting/format";
import type { BlockRenderContext } from "./types";
import { ProvenanceBadge } from "./ProvenanceBadge";
import { ShowWorkButton } from "./ShowWorkButton";
import { AskButton } from "./AskButton";
import { CommentButton } from "./CommentButton";
import { useTheme } from "@/components/providers/ThemeProvider";
import { useCurrency } from "@/components/providers/CurrencyProvider";
import { BlockActions } from "./BlockActions";
import { BlockEmptyState } from "./BlockEmptyState";
import { cn } from "@/lib/utils";
import { STATUS_ALIASES, STATUS_LEGEND_ORDER } from "./heatmapStatus";
import { useT } from "@/lib/i18n/LocaleContext";
import { useDrillThrough } from "@/components/providers/drill-through-context";

/**
 * Heatmap block — pure SVG, two visual modes (calendar + grid).
 *
 *   - "calendar": GitHub-style 53-week × 7-day grid. Aggregates rows by ISO
 *     date and shades cells by intensity. Spans the most-recent ~year of
 *     dates present in the dataset (so it stays meaningful regardless of
 *     when the data is from).
 *
 *   - "grid": 2D categorical heatmap. xField across the top, yField down
 *     the side, valueField in each cell. The query is expected to already
 *     have the cell grain (one row per [x, y] pair). Multiple rows per cell
 *     get aggregated client-side using the configured aggregation.
 *
 * Color ramp is a single-hue scale from a faint background to a saturated
 * primary, parameterised by the `ramp` config. Negative values flip to a
 * destructive (red) ramp - useful for variance heatmaps.
 */

/**
 * Fixed ramp slugs (semantic shortcuts). The "primary" slug is special —
 * it routes through the report's theme via useTheme().ramps.primary so
 * the heatmap color scale follows the theme. Other slugs stay constant
 * because they're meaning-bound (emerald = good, rose = bad, etc).
 */
const FIXED_RAMP_TIPS: Record<string, string> = {
  emerald: "#10b981",
  amber:   "#f59e0b",
  rose:    "#f43f5e",
  cyan:    "#06b6d4",
};
const NEG_RAMP = "#f43f5e";

function fmt(v: number, kind: "number" | "currency" | "percent" | "compact", currency?: string): string {
  if (v == null || Number.isNaN(v)) return "";
  if (kind === "currency") return formatCurrency(v, currency);
  if (kind === "percent")  return formatPercent(v);
  if (kind === "compact") {
    const abs = Math.abs(v);
    if (abs >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
    if (abs >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (abs >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return v.toLocaleString();
  }
  return formatNumber(v);
}

export function HeatmapBlock({ block, dataset, provenance, print, report, params, reportDbId, bare }: BlockRenderContext) {
  const { t } = useT();
  if (block.type !== "heatmap") return null;
  const cfg = block.config;
  const rows = (dataset[cfg.queryId] ?? []) as Record<string, unknown>[];
  const proof = !print && provenance ? provenance[cfg.queryId] : undefined;
  const ds = !print ? report.dataSources.find((d) => d.id === cfg.queryId) ?? null : null;

  if (!cfg.queryId || rows.length === 0) {
    return <BlockEmptyState type="heatmap" blockId={block.id} title={cfg.title} description={t("blockEmpty.noData")} />;
  }

  return (
    <div className={cn(
      "group relative flex h-full flex-col overflow-hidden",
      bare ? "p-1" : "rounded-report border border-border bg-card p-4 shadow-xs",
    )}>
      {!print && (proof || ds) && (
        <div className="absolute right-2 top-2 z-10">
          <BlockActions>
            {reportDbId && <AskButton reportId={reportDbId} blockId={block.id} blockType="chart" params={params} />}
            {reportDbId && <CommentButton reportId={reportDbId} blockId={block.id} proofHash={proof?.queryHash} />}
            {ds && <ShowWorkButton ds={ds} rows={rows} params={params} />}
            {proof && <ProvenanceBadge record={proof} />}
          </BlockActions>
        </div>
      )}
      {!bare && (cfg.title || cfg.subtitle) && (
        <header className="mb-3 pr-12">
          {cfg.title && <h3 className="text-sm font-semibold text-foreground">{cfg.title}</h3>}
          {cfg.subtitle && <p className="mt-0.5 text-[11px] text-muted-foreground">{cfg.subtitle}</p>}
        </header>
      )}
      <div className={"min-h-0 flex-1 overflow-auto " + (bare ? "pt-8" : "")}>
        {cfg.mode === "calendar" ? <CalendarHeatmap rows={rows} cfg={cfg} />
          : cfg.mode === "tiles" ? <TilesHeatmap rows={rows} cfg={cfg} blockId={block.id} activeValue={cfg.drillParam ? (params as any)?.[cfg.drillParam] : undefined} />
          : <GridHeatmap rows={rows} cfg={cfg} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calendar heatmap
// ---------------------------------------------------------------------------

function CalendarHeatmap({ rows, cfg }: { rows: Record<string, unknown>[]; cfg: any }) {
  const dateField = cfg.dateField ?? "date";
  const valueField = cfg.valueField;

  // Aggregate rows by ISO date.
  const byDate = useMemo(() => {
    const acc: Record<string, { sum: number; count: number; min: number; max: number }> = {};
    for (const r of rows) {
      const raw = r[dateField];
      if (raw == null) continue;
      const iso = String(raw).slice(0, 10); // YYYY-MM-DD
      const v = Number(r[valueField]);
      if (!Number.isFinite(v)) continue;
      const e = acc[iso] ?? { sum: 0, count: 0, min: Infinity, max: -Infinity };
      e.sum += v; e.count += 1;
      if (v < e.min) e.min = v;
      if (v > e.max) e.max = v;
      acc[iso] = e;
    }
    return acc;
  }, [rows, dateField, valueField]);

  const valueOf = (e: typeof byDate[string]) => {
    if (cfg.aggregation === "avg") return e.sum / e.count;
    if (cfg.aggregation === "count") return e.count;
    if (cfg.aggregation === "min") return e.min;
    if (cfg.aggregation === "max") return e.max;
    return e.sum;
  };

  // Pick a 1-year window ending at the most recent date in the data (or
  // today, if there is no data — keeps the layout sensible during loading).
  const dates = Object.keys(byDate).sort();
  const end = dates.length ? new Date(dates[dates.length - 1] + "T00:00:00Z") : new Date();
  const start = new Date(end);
  start.setUTCFullYear(start.getUTCFullYear() - 1);

  // Walk every day in [start..end] and bucket into weeks (column) × weekday (row).
  // Sunday is row 0 to match GitHub's contributions calendar.
  const weeks: Array<Array<{ iso: string; value: number | null }>> = [];
  let week: Array<{ iso: string; value: number | null }> = [];
  // Pad to start on a Sunday for visual cleanliness.
  const cursor = new Date(start);
  cursor.setUTCDate(cursor.getUTCDate() - cursor.getUTCDay());
  while (cursor <= end) {
    const iso = cursor.toISOString().slice(0, 10);
    const e = byDate[iso];
    week.push({ iso, value: e ? valueOf(e) : null });
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  if (week.length) weeks.push(week);

  // Heatmap range from the actual data (ignore null cells).
  const allValues = weeks.flatMap((w) => w.map((c) => c.value).filter((v): v is number => v != null));
  const maxAbs = Math.max(1, ...allValues.map((v) => Math.abs(v)));

  // Theme-aware ramp tip. "primary" routes through the active theme's
  // primary ramp so the heatmap intensity follows the report theme; the
  // semantic slugs (emerald/rose/etc) stay constant by design.
  const theme = useTheme();
  const currency = useCurrency();
  const slug = cfg.ramp ?? "primary";
  const ramp = slug === "primary"
    ? theme.ramps.primary[theme.ramps.primary.length - 1]
    : (FIXED_RAMP_TIPS[slug] ?? theme.ramps.primary[theme.ramps.primary.length - 1]);

  // Visual constants.
  const CELL = 12;
  const GAP = 2;
  const LEFT_GUTTER = 26;
  const TOP_GUTTER = 16;
  const width = LEFT_GUTTER + weeks.length * (CELL + GAP);
  const height = TOP_GUTTER + 7 * (CELL + GAP) + 16;

  // Month labels along the top.
  const monthLabels = labelMonths(weeks);

  function cellColor(v: number | null): string {
    if (v == null) return "rgba(15,23,42,0.04)"; // empty day
    if (v < 0) {
      const t = Math.min(1, Math.abs(v) / maxAbs);
      return colorMix(NEG_RAMP, Math.round(15 + t * 60));
    }
    const t = Math.min(1, v / maxAbs);
    if (t < 0.05) return colorMix(ramp, 8);
    return colorMix(ramp, Math.round(15 + t * 70));
  }

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="block">
        {monthLabels.map((m) => (
          <text key={m.label + m.x} x={LEFT_GUTTER + m.x} y={11}
            className="fill-muted-foreground" fontSize={10}>{m.label}</text>
        ))}
        {[0, 2, 4, 6].map((row) => (
          <text key={row} x={0} y={TOP_GUTTER + row * (CELL + GAP) + CELL - 1}
            className="fill-muted-foreground" fontSize={9}>
            {WEEKDAYS[row]}
          </text>
        ))}
        {weeks.map((w, wi) => (
          <g key={wi} transform={`translate(${LEFT_GUTTER + wi * (CELL + GAP)},${TOP_GUTTER})`}>
            {w.map((cell, ci) => (
              <rect
                key={cell.iso}
                x={0} y={ci * (CELL + GAP)} width={CELL} height={CELL}
                rx={2} ry={2}
                fill={cellColor(cell.value)}
                stroke="rgba(15,23,42,0.04)" strokeWidth={0.5}
              >
                <title>{cell.value != null
                  ? `${cell.iso} — ${fmt(cell.value, cfg.format ?? "compact", currency)}`
                  : `${cell.iso} — no data`}</title>
              </rect>
            ))}
          </g>
        ))}
      </svg>

      {/* Legend */}
      <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
        <span>less</span>
        {[0.1, 0.3, 0.55, 0.8, 1].map((t, i) => (
          <span key={i}
            className="inline-block h-3 w-3 rounded-sm"
            style={{ background: colorMix(ramp, Math.round(15 + t * 70)) }}
          />
        ))}
        <span>more</span>
        <span className="ml-auto">
          {dates.length} day{dates.length === 1 ? "" : "s"} with data ·
          peak {fmt(maxAbs, cfg.format ?? "compact", currency)}
        </span>
      </div>
    </div>
  );
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Find the column index where each month first appears, for axis labels. */
function labelMonths(weeks: Array<Array<{ iso: string }>>): Array<{ x: number; label: string }> {
  let lastMonth = -1;
  const out: Array<{ x: number; label: string }> = [];
  weeks.forEach((w, wi) => {
    const first = w[0]?.iso;
    if (!first) return;
    const m = parseInt(first.slice(5, 7), 10) - 1;
    if (m !== lastMonth) {
      out.push({ x: wi * 14, label: MONTHS[m] });
      lastMonth = m;
    }
  });
  return out;
}

// CSS color-mix-ish: blend hex toward transparent at the given alpha (0-100).
function colorMix(hex: string, alphaPct: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${(alphaPct / 100).toFixed(2)})`;
}

// ---------------------------------------------------------------------------
// Tiles (status board)
// ---------------------------------------------------------------------------

// STATUS_ALIASES / STATUS_LEGEND_ORDER (imported above) moved to
// ./heatmapStatus.ts (plain data, no "use client") so a Server Component
// (the Analytic App Executive tab's DeliveryHeatmap) can read them too —
// importing a named export from this file, even a plain object, would
// resolve to an opaque client reference on the server and crash.
// Re-exported here for anything already importing them from this file.
export { STATUS_ALIASES, STATUS_LEGEND_ORDER };

/**
 * One tile per row, wrapped in a responsive grid — the status-board shape
 * (sites, regions, accounts), which the matrix modes can't express because
 * they need two axes and shade only by magnitude.
 *
 * Colour comes from `statusField` mapped onto the theme's semantic tokens.
 * Without that field it falls back to the same intensity ramp grid mode
 * uses, so the mode still works when all you have is a number.
 */
function TilesHeatmap({
  rows, cfg, blockId, activeValue,
}: {
  rows: Record<string, unknown>[];
  cfg: any;
  blockId: string;
  /** Current value of cfg.drillParam on THIS report's own params — rings
   *  the matching tile, same convention DashboardViewer's breadcrumb uses. */
  activeValue?: unknown;
}) {
  const theme = useTheme();
  const currency = useCurrency();
  const { t } = useT();
  const onDrill = useDrillThrough();
  const { labelField, codeField, statusField, valueField } = cfg;
  // No dead click: a button only when there's somewhere for the click to
  // go — a drillParam declared on this block AND a surface (Dashboard
  // viewer, or the app viewer's own DrillThroughContext) actually
  // providing a handler for it.
  const drillEnabled = !!onDrill && !!cfg.drillParam && !!codeField;

  const slug = cfg.ramp ?? "primary";
  const rampTip = slug === "primary"
    ? theme.ramps.primary[theme.ramps.primary.length - 1]
    : (FIXED_RAMP_TIPS[slug] ?? theme.ramps.primary[theme.ramps.primary.length - 1]);

  // A tile per row means an unbounded query renders unbounded DOM. The
  // matrix modes are naturally bounded by their axes; this one isn't, so
  // it truncates and says so rather than locking up the page.
  const MAX_TILES = 60;
  const shown = rows.slice(0, MAX_TILES);
  const overflow = rows.length - shown.length;

  const values = rows.map((r) => Number(r[valueField])).filter((v) => Number.isFinite(v));
  const maxAbs = Math.max(1, ...values.map((v) => Math.abs(v)));

  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {shown.map((r, i) => {
          const v = Number(r[valueField]);
          const hasValue = Number.isFinite(v);
          const rawStatus = statusField ? String(r[statusField] ?? "").trim().toLowerCase() : "";
          const status = rawStatus ? (STATUS_ALIASES[rawStatus] ?? "neutral") : null;

          // Solid semantic fill carries white text; the ramp fallback is a
          // translucent tint, so it keeps the card's own foreground colour.
          const solid = status ? theme.semantic[status] : null;
          const background = solid
            ?? (hasValue ? colorMix(rampTip, Math.round(15 + Math.min(1, Math.abs(v) / maxAbs) * 70)) : colorMix(rampTip, 8));

          // Belt-and-braces display clamp: only when the block explicitly
          // declares this field as a percent (fmt()'s "percent" kind treats
          // 1.0 as 100%) — a generic currency/count heatmap must never have
          // its real numbers silently rewritten. Real bound data can be as
          // dirty as synthetic data was before the underlying-hint fix; the
          // row itself is untouched, only the shown figure is bounded.
          const capped = cfg.format === "percent" && hasValue && v > 1;
          const displayV = capped ? 1 : v;
          const title = capped ? t("heatmap.valueCapped").replace("{n}", String(Math.round(v * 100))) : undefined;

          const codeVal = codeField != null ? r[codeField] : undefined;
          const tileDrillEnabled = drillEnabled && codeVal != null;
          const active = tileDrillEnabled && activeValue != null && String(activeValue) === String(codeVal);

          const inner = (
            <>
              <div className="min-w-0">
                {codeField != null && r[codeField] != null && (
                  <div className={`font-mono text-[10px] ${solid ? "opacity-85" : "opacity-70"}`}>
                    {String(r[codeField])}
                  </div>
                )}
                {labelField != null && (
                  <div className="truncate text-xs font-semibold leading-snug">{String(r[labelField] ?? "")}</div>
                )}
              </div>
              <div className={`font-mono text-[11px] ${solid ? "opacity-90" : "opacity-75"}`}>
                {hasValue ? fmt(displayV, cfg.format, currency) : ""}
                {rawStatus && <span>{hasValue ? " · " : ""}{String(r[statusField])}</span>}
              </div>
            </>
          );
          const tileCls = `flex min-h-[74px] flex-col justify-between gap-2 rounded-lg p-2.5 text-left transition-shadow ${solid ? "text-white" : "text-foreground"}`
            + (active ? " ring-2 ring-offset-2 ring-offset-background ring-foreground" : "");

          if (tileDrillEnabled) {
            return (
              <button
                key={i}
                type="button"
                title={title}
                className={tileCls}
                style={{ background }}
                onClick={() => onDrill!(blockId, active ? "" : codeVal)}
              >
                {inner}
              </button>
            );
          }
          return (
            <div key={i} title={title} className={tileCls} style={{ background }}>
              {inner}
            </div>
          );
        })}
      </div>
      {statusField && (() => {
        // Only the statuses actually present among the shown tiles — a
        // legend listing five tones when the data only ever produced two
        // reads as noise, not help.
        const present = new Set(
          shown
            .map((r) => String(r[statusField] ?? "").trim().toLowerCase())
            .filter(Boolean)
            .map((s) => STATUS_ALIASES[s] ?? "neutral"),
        );
        const entries = STATUS_LEGEND_ORDER.filter((e) => present.has(e.key));
        if (entries.length === 0) return null;
        return (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
            {entries.map((e) => (
              <span key={e.key} className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ background: theme.semantic[e.key] }}
                />
                {e.label}
              </span>
            ))}
          </div>
        );
      })()}
      {overflow > 0 && (
        <p className="mt-2 text-[11px] text-muted-foreground">+{overflow} more not shown</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grid heatmap (categorical x categorical)
// ---------------------------------------------------------------------------

function GridHeatmap({ rows, cfg }: { rows: Record<string, unknown>[]; cfg: any }) {
  const xField = cfg.xField ?? "x";
  const yField = cfg.yField ?? "y";
  const valueField = cfg.valueField;

  // Aggregate rows into a [y][x] -> {sum,count,min,max} matrix.
  type Bucket = { sum: number; count: number; min: number; max: number };
  const matrix: Record<string, Record<string, Bucket>> = {};
  const xKeys = new Set<string>();
  const yKeys = new Set<string>();
  for (const r of rows) {
    const x = String(r[xField] ?? "—");
    const y = String(r[yField] ?? "—");
    const v = Number(r[valueField]);
    if (!Number.isFinite(v)) continue;
    xKeys.add(x); yKeys.add(y);
    matrix[y] = matrix[y] ?? {};
    const e = matrix[y][x] ?? { sum: 0, count: 0, min: Infinity, max: -Infinity };
    e.sum += v; e.count += 1;
    if (v < e.min) e.min = v;
    if (v > e.max) e.max = v;
    matrix[y][x] = e;
  }
  const xs = Array.from(xKeys).sort();
  const ys = Array.from(yKeys).sort();
  const valueOf = (e?: Bucket) => {
    if (!e) return null;
    if (cfg.aggregation === "avg") return e.sum / e.count;
    if (cfg.aggregation === "count") return e.count;
    if (cfg.aggregation === "min") return e.min;
    if (cfg.aggregation === "max") return e.max;
    return e.sum;
  };
  const allValues = ys.flatMap((y) => xs.map((x) => valueOf(matrix[y]?.[x])).filter((v): v is number => v != null));
  const maxAbs = Math.max(1, ...allValues.map((v) => Math.abs(v)));
  // Theme-aware ramp tip. "primary" routes through the active theme's
  // primary ramp so the heatmap intensity follows the report theme; the
  // semantic slugs (emerald/rose/etc) stay constant by design.
  const theme = useTheme();
  const currency = useCurrency();
  const slug = cfg.ramp ?? "primary";
  const ramp = slug === "primary"
    ? theme.ramps.primary[theme.ramps.primary.length - 1]
    : (FIXED_RAMP_TIPS[slug] ?? theme.ramps.primary[theme.ramps.primary.length - 1]);

  // Layout.
  const CELL_W = Math.max(28, Math.min(60, Math.floor(560 / Math.max(1, xs.length))));
  const CELL_H = 28;
  const GAP = 2;
  const LEFT_GUTTER = 90;
  const TOP_GUTTER = 24;
  const width = LEFT_GUTTER + xs.length * (CELL_W + GAP);
  const height = TOP_GUTTER + ys.length * (CELL_H + GAP) + 8;

  function cellColor(v: number | null): string {
    if (v == null) return "rgba(15,23,42,0.04)";
    if (v < 0) {
      const t = Math.min(1, Math.abs(v) / maxAbs);
      return colorMix(NEG_RAMP, Math.round(15 + t * 60));
    }
    const t = Math.min(1, v / maxAbs);
    if (t < 0.05) return colorMix(ramp, 8);
    return colorMix(ramp, Math.round(15 + t * 70));
  }

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="block">
      {/* X axis labels */}
      {xs.map((x, i) => (
        <text key={x} x={LEFT_GUTTER + i * (CELL_W + GAP) + CELL_W / 2} y={16}
          className="fill-muted-foreground" fontSize={10} textAnchor="middle">{x}</text>
      ))}
      {/* Y axis labels */}
      {ys.map((y, j) => (
        <text key={y} x={LEFT_GUTTER - 6} y={TOP_GUTTER + j * (CELL_H + GAP) + CELL_H / 2 + 3}
          className="fill-muted-foreground" fontSize={10} textAnchor="end">{y}</text>
      ))}
      {/* Cells */}
      {ys.map((y, j) =>
        xs.map((x, i) => {
          const v = valueOf(matrix[y]?.[x]);
          return (
            <g key={x + y} transform={`translate(${LEFT_GUTTER + i * (CELL_W + GAP)},${TOP_GUTTER + j * (CELL_H + GAP)})`}>
              <rect width={CELL_W} height={CELL_H} rx={3} ry={3} fill={cellColor(v)}
                stroke="rgba(15,23,42,0.06)" strokeWidth={0.5}>
                <title>{v != null
                  ? `${x} × ${y} — ${fmt(v, cfg.format ?? "compact", currency)}`
                  : `${x} × ${y} — no data`}</title>
              </rect>
              {v != null && CELL_W >= 36 && (
                <text x={CELL_W / 2} y={CELL_H / 2 + 3} textAnchor="middle" fontSize={10}
                  fill={Math.abs(v) / maxAbs > 0.6 ? "white" : "#334155"} fontWeight={500}>
                  {fmt(v, cfg.format ?? "compact", currency)}
                </text>
              )}
            </g>
          );
        })
      )}
    </svg>
  );
}
