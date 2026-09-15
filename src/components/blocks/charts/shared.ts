/**
 * Chart-rendering primitives shared between ChartBlock.tsx and the
 * per-chart-type renderer modules under this directory. Moved here (rather
 * than exported from ChartBlock.tsx directly) to avoid a circular import —
 * ChartBlock.tsx imports renderers from this directory, so those renderers
 * can't import back from ChartBlock.tsx.
 */
import type { ReactNode } from "react";
import { currencySymbol } from "@/lib/reporting/currency";
import { CHART_STYLE_PRESETS, type ResolvedChartStyle } from "@/lib/reporting/chartStyles";
import type { ForecastConfig } from "@/lib/reporting/schema";

/**
 * The full set of values a per-chart-type renderer might need. Every
 * renderer destructures only the fields it actually uses; keeping one
 * shared, fully-optional-where-possible shape means a call site can pass
 * the same object to any renderer without per-chart-type wrapper types,
 * and TypeScript still catches a missing *required* field at compile time.
 */
export type ChartRenderCtx = {
  data: unknown[];
  xField: string;
  yFields: string[];
  cfg: any;
  palette: string[];
  fmt: "number" | "currency" | "percent" | "compact";
  currency?: string;
  print?: boolean;
  showLegend?: boolean;
  showDataLabels?: boolean;
  /** Stable per-block id fragment for SVG gradient/def ids (gid = "graphic id"). */
  gid?: string;
  stacked?: boolean;
  /** Combo chart only — dataKeys that render as a Line instead of a Bar. */
  lineFields?: string[];
  /** Pie chart only — true renders a donut (inner radius) instead of a full pie. */
  isDonut?: boolean;
  /** Pie chart's own slice-click handler is bespoke (not handleClick). */
  drillEnabled?: boolean;
  onDrill?: (blockId: string, value: unknown) => void;
  blockId?: string;
  handleClick: (payload: any) => void;
  /** yAxisId param: only combo charts need it (they declare two named axes,
   *  "left"/"right", instead of the single default every other chart type
   *  renders against) — see renderComboChart's call sites. */
  renderReferenceLines: (yAxisId?: string) => ReactNode;
  renderAnnotations: (yAxisId?: string) => ReactNode;
  renderForecastDecor: (yAxisId?: string) => ReactNode;
  /**
   * Raw forecast config (undefined when off) — needed by the bar/line/area/
   * combo renderers to split the series into a solid actual segment and a
   * dashed predicted tail, distinct from `renderForecastDecor` which only
   * draws the boundary marker/band, not the series styling itself.
   */
  forecast?: ForecastConfig;
  /** Theme semantic tokens — gauge/bullet zone tints derive from these, not a fixed pastel map. */
  semantic?: Record<string, string>;
  /** Theme's 5-stop "faint to saturated" primary ramp — a funnel's segment
   *  shading derives from this (progression, not a rainbow of unrelated
   *  hues), the same ramp heatmap/map/table intensity fills already use. */
  ramp?: string[];
  /**
   * Resolved chart *form* tokens (corner radius, gradient vs flat, whether
   * there's a value axis at all). Separate from `palette`, which is the colour
   * axis. Optional so a caller that hasn't been migrated still renders — the
   * helpers below fall back to "classic", which is today's exact look.
   */
  style?: ResolvedChartStyle;
};

/** Style tokens with the classic fallback applied, for renderers to read. */
export function styleOf(ctx: ChartRenderCtx): ResolvedChartStyle {
  return ctx.style ?? CHART_STYLE_PRESETS.classic;
}

/**
 * CartesianGrid props for a style's grid mode. Returns null for "none" so the
 * caller can skip rendering the element entirely rather than draw an invisible
 * one (an empty <CartesianGrid> still emits DOM and still costs layout).
 */
export function gridPropsFor(style: ResolvedChartStyle, opts?: { vertical?: boolean; horizontal?: boolean }) {
  if (style.grid === "none") return null;
  const soft = style.grid === "soft";
  return {
    strokeDasharray: soft ? "1 5" : "2 4",
    stroke: GRID_STROKE,
    strokeOpacity: soft ? 0.85 : 0.7,
    vertical: opts?.vertical ?? false,
    horizontal: opts?.horizontal ?? true,
  };
}

/**
 * One <defs> block of vertical (or horizontal) gradients, one per colour.
 * Extracted here rather than repeated per renderer: lineAreaComboRenderers had
 * the only copy, and bringing bar/pie/treemap/waterfall up to the same
 * treatment would otherwise have meant four more near-identical blocks.
 *
 * Ids are namespaced by `gid` (the per-block graphic id) so two charts on the
 * same page can't collide — SVG gradient ids are document-global.
 */
export function gradientId(prefix: string, gid: string | undefined, i: number): string {
  return `${prefix}-${gid ?? "x"}-${i}`;
}
export function gradientUrl(prefix: string, gid: string | undefined, i: number): string {
  return `url(#${gradientId(prefix, gid, i)})`;
}

function compactNum(v: number): string {
  if (v == null || Number.isNaN(v)) return "";
  const abs = Math.abs(v);
  if (abs >= 1e12) return (v / 1e12).toFixed(1).replace(/\.0$/, "") + "T";
  if (abs >= 1e9)  return (v / 1e9).toFixed(1).replace(/\.0$/, "")  + "B";
  if (abs >= 1e6)  return (v / 1e6).toFixed(1).replace(/\.0$/, "")  + "M";
  if (abs >= 1e3)  return (v / 1e3).toFixed(0) + "K";
  return String(v);
}

export function formatValue(
  v: number,
  fmt: "number" | "currency" | "percent" | "compact",
  currency?: string,
  opts?: {
    /**
     * Defaults to true, matching every existing caller (axis ticks,
     * tooltips) — those genuinely risk clipping in a narrow gutter or
     * crowding a floating box. Pass false for a label with real room to
     * spread out, like a funnel/pie segment's own on-shape value label:
     * that context has none of the clipping risk the compaction below
     * exists for, and a reader looking directly at one segment's number
     * expects the real figure, not "61K".
     */
    compact?: boolean;
  }
): string {
  if (v == null || Number.isNaN(v)) return "";
  const compact = opts?.compact ?? true;
  if (fmt === "currency") {
    // Threshold on the MAGNITUDE, not the signed value. Comparing `v >= 1000`
    // sent every negative down the non-compact branch, so an axis spanning
    // zero rendered "$1.1M" above the origin and "$-1,100,000" below it —
    // long enough to be clipped by the 56px axis gutter, which is how it
    // reached the screen as ",100,000". Sign leads the symbol, as convention
    // has it: -$1.1M, not $-1.1M.
    const abs = Math.abs(v);
    const sign = v < 0 ? "-" : "";
    return sign + currencySymbol(currency ?? "USD") + (compact && abs >= 1000
      ? compactNum(abs)
      : abs.toLocaleString(undefined, { maximumFractionDigits: 2 }));
  }
  // Percent fields are stored as 0-1 fractions everywhere in this codebase
  // (see formatPercent() in lib/reporting/format.ts, enforced at the SQL-
  // generation layer by autoCurf.ts's percentStoredAsPoints()) — always
  // scale by 100, never guess from magnitude. A magnitude guess breaks any
  // fraction that legitimately crosses 1.0 (101.7% stored as 1.017 would
  // render as "1.0%").
  if (fmt === "percent")  return (v * 100).toFixed(1) + "%";
  if (fmt === "compact")  return compactNum(v);
  // Plain "number" — same clipping risk as "currency" above (a full
  // "2,500,000" is long enough to be clipped by the 56px axis gutter, which
  // is how it reaches the screen as ",000,000"), so mirror the same
  // magnitude-based compacting: full precision below 1000, compact above.
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  return sign + (compact && abs >= 1000 ? compactNum(abs) : abs.toLocaleString(undefined, { maximumFractionDigits: 2 }));
}

// Chart ink comes from the design tokens (globals.css), so a chart reads the
// same on the card surface in both themes — never a hardcoded slate/indigo.
// `hsl(var(--x))` resolves inside SVG presentation attributes too.
export const GRID_STROKE = "hsl(var(--border))";
export const TICK_FILL = "hsl(var(--faint))";
export const LABEL_FILL = "hsl(var(--muted-foreground))";
export const CURSOR_FILL = "hsl(var(--primary) / 0.06)";
/**
 * Fill for a mark that sits OUTSIDE the finding an `emphasisTop` chart is
 * arguing. Derived from the muted ink token rather than a fixed grey so it
 * recedes the same amount on a light card and a dark one — a flat hex tuned
 * for white turns into a bright block in dark mode. Deliberately still
 * legible: a de-emphasised bar is context, not a hidden row.
 */
export const DEEMPHASIS_FILL = "hsl(var(--muted-foreground) / 0.28)";
export const LEGEND_STYLE = { fontSize: 11, paddingTop: 12, color: "hsl(var(--muted-foreground))" };

// Muted ticks, no axis line, no tick line — keeps the chart "floating" on
// the card surface instead of looking boxed in.
export const AXIS_PROPS = {
  tick: { fill: TICK_FILL, fontSize: 10.5, fontWeight: 500 },
  tickLine: false,
  axisLine: false as const,
  tickMargin: 8,
};

/**
 * Fixed Y-axis gutter width, shared by every chart type that renders a
 * value axis (line/area/combo/bar/scatter/treemap+waterfall). Was 56 —
 * enough for a 6-character compact tick like "THB75K" but not a 7-character
 * one like "THB100K", which lost its leading "T" off the left edge of the
 * gutter (reported live: axis showing "HB100K"). 64 covers the common
 * "<3-letter currency><1-3 digits><K/M/B/T>" shapes with a little slack;
 * still a fixed guess, not a measured width — a genuinely unbounded label
 * (a long custom currency code, say) could still clip, but that's a much
 * rarer case than the one this was actually hit by.
 */
export const Y_AXIS_WIDTH = 64;

/**
 * Y-axis-only domain (never spread onto an XAxis — category-axis domain
 * semantics are completely different). Without an explicit domain,
 * Recharts' own "nice tick" rounding can add a whole extra tick's worth of
 * padding BELOW zero even when every rendered value is positive — e.g. a
 * chart whose real data tops out just under 1M got ticks
 * [-350K, 0, 350K, 700K, 1.1M], wasting the bottom quarter of the plot on
 * a range nothing ever uses. Clamping the floor to whichever is smaller —
 * 0, or the data's real minimum — removes that dead band for the common
 * all-non-negative case (revenue, counts, currency) while leaving genuinely
 * negative series (P&L deltas, waterfall running totals, temperature) fully
 * intact: dataMin only wins when it's actually below zero.
 */
export const Y_AXIS_DOMAIN: [(dataMin: number) => number, string] = [
  (dataMin: number) => Math.min(0, dataMin),
  "auto",
];

// Tremor-style tooltip: pill-rounded, soft layered shadow, no aggressive
// border. Sits above the chart on a translucent backdrop so it never
// fights the underlying paint.
/**
 * Default 10-color categorical palette. Tuned for clarity over saturation:
 *   - First 6 cover the common pitch case (≤6 series)
 *   - Each picks a distinct hue family, no two adjacent ramps
 *   - All readable on white AND on dark muted surfaces
 *   - Indigo / emerald / amber / rose / cyan / violet / sky / pink / orange / lime
 *
 * The chart resolves the *active* palette at render time from the report's
 * `theme` field via `paletteFor(report.theme)` — this constant only acts as
 * the fallback when no theme is set or the slug is unknown.
 */
export const DEFAULT_PALETTE = [
  "#6366f1", // indigo-500 (primary brand)
  "#10b981", // emerald-500
  "#f59e0b", // amber-500
  "#f43f5e", // rose-500
  "#06b6d4", // cyan-500
  "#8b5cf6", // violet-500
  "#0ea5e9", // sky-500
  "#ec4899", // pink-500
  "#f97316", // orange-500
  "#84cc16", // lime-500
];

export const TOOLTIP_STYLE = {
  backgroundColor: "hsl(var(--card) / 0.96)",
  border: "1px solid hsl(var(--border))",
  borderRadius: 8,
  boxShadow: "var(--shadow-md)",
  color: "hsl(var(--foreground))",
  fontSize: 11.5,
  padding: "8px 12px",
  backdropFilter: "blur(8px)",
};
