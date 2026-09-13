/**
 * Chart style presets — the *form* half of the design system.
 *
 * Deliberately a separate axis from `theme` (lib/reporting/themes.ts). A theme
 * decides what a chart is COLOURED with (palette, ramps, fonts); a chart style
 * decides what a chart is SHAPED like (corner radius, gradient vs flat, ghost
 * tracks, whether there's a value axis at all). They're orthogonal — a tenant
 * can want their own brand palette rendered in the Enterprise form, or the
 * Curf default palette rendered in Modern — so overloading ThemeSchema with
 * style slugs would have forced a 5 x 3 preset matrix and made custom palettes
 * mutually exclusive with either look.
 *
 * Every knob a renderer needs lives in this token object. Renderers read
 * tokens; they never branch on the slug. That's what keeps a new preset a
 * data change here rather than another `if` in twelve renderer files.
 *
 * Resolution mirrors the theme cascade exactly (see ThemeProvider):
 *   user override → report.chartStyle → tenant.brandJson.defaultChartStyle → "classic"
 *
 * "classic" reproduces today's rendering EXACTLY, and is the fallback for any
 * unknown slug, so every report that predates this feature keeps the look it
 * shipped with. Modern and Enterprise are strictly opt-in.
 */
import type { ChartStyle } from "@/lib/reporting/schema";

/** Where a ghost track is drawn behind bars. */
export type TrackMode = "never" | "list" | "always";
/** Grid line treatment on the value axis. */
export type GridMode = "dashed" | "soft" | "none";

export type ResolvedChartStyle = {
  slug: ChartStyle;
  label: string;
  description: string;

  bar: {
    /** Corner radius on the value end of a bar. */
    radius: number;
    /**
     * Corner radius for the bars *inside* a combo chart. Its own token because
     * combo already shipped at 6 while plain bars shipped at 3 — folding them
     * into one value would have silently restyled every existing combo chart
     * the moment "classic" was introduced.
     */
    comboRadius: number;
    /** Horizontal single-series bars render as full pills (radius = half thickness). */
    pill: boolean;
    /**
     * "list"   — only behind a horizontal ranked list (today's behaviour)
     * "always" — behind every single-series bar
     * "never"  — no track; a print exhibit has no hover affordance to hint at
     */
    track: TrackMode;
    maxBarSize: { vertical: number; horizontal: number };
    categoryGap: { vertical: string; horizontal: string };
  };

  fill: {
    /** Vertical (or horizontal, for rotated bars) gradient instead of a flat fill. */
    gradient: boolean;
    /** stopOpacity at the 0% and 100% stops. */
    stops: readonly [number, number];
  };

  grid: GridMode;
  /**
   * Show the numeric value axis. When false the renderer substitutes direct
   * data labels — but only where they actually fit; see `directLabelsFit()`.
   */
  valueAxis: boolean;
  /** Turn data labels on even when the block config didn't ask for them. */
  forceDataLabels: boolean;

  pie: { cornerRadius: number; innerRadius: string; paddingAngle: number };
  treemap: {
    rx: number;
    strokeWidth: number;
    /**
     * Cell colour comes from palette[0] for every cell rather than cycling the
     * palette by array index. Index-based colour on a treemap encodes nothing —
     * area already carries magnitude — so monochrome removes a channel that was
     * only ever decorative.
     */
    monochrome: boolean;
  };
  area: {
    strokeWidth: number;
    roundCap: boolean;
    /** Draw the area fill under the line at all. */
    filled: boolean;
    /** Fade the fill to fully transparent rather than to a 0.05 floor. */
    fadeToZero: boolean;
  };
  /**
   * Line-chart stroke, kept separate from `area` above: a line has always
   * shipped at 2.5 while an area's outline shipped at 2, so one shared token
   * would have restyled every existing line chart the moment classic landed —
   * the same trap as bar.comboRadius.
   */
  line: {
    strokeWidth: number;
    roundCap: boolean;
    /** Marker dot on every data point. The tooltip's activeDot is unaffected. */
    dots: boolean;
  };
  /**
   * Interactive chrome inside the plot — today the drag-to-zoom Brush strip.
   * A print-oriented style drops it: the same call `print` already makes when
   * capturing a PDF, extended to a style built for board packs.
   */
  showBrush: boolean;
  waterfall: {
    /** Dashed step connectors between bars. */
    connectors: boolean;
    /** Label each step with a signed delta (+96 / −642) rather than a bare value. */
    signedLabels: boolean;
  };
};

/**
 * Direct labels replace a value axis only while they fit. Past this many
 * categories they collide and the axis is the better read — the same trade
 * barRenderer already makes for its horizontal "ranked list" mode at 12 rows.
 * Multi-series charts always keep the axis: labels on grouped or stacked bars
 * overlap regardless of count.
 */
export function directLabelsFit(rowCount: number, singleSeries: boolean): boolean {
  return singleSeries && rowCount <= 12;
}

export const CHART_STYLE_PRESETS: Record<ChartStyle, ResolvedChartStyle> = {
  classic: {
    slug: "classic",
    label: "Classic",
    description: "Flat fills, tight corners, a value axis on every chart. Curf's original look.",
    bar: {
      radius: 3,
      comboRadius: 6,
      pill: false,
      track: "list",
      maxBarSize: { vertical: 48, horizontal: 14 },
      categoryGap: { vertical: "20%", horizontal: "35%" },
    },
    fill: { gradient: false, stops: [1, 1] },
    grid: "dashed",
    valueAxis: true,
    forceDataLabels: false,
    pie: { cornerRadius: 0, innerRadius: "55%", paddingAngle: 2 },
    treemap: { rx: 3, strokeWidth: 2, monochrome: false },
    area: { strokeWidth: 2, roundCap: false, filled: true, fadeToZero: false },
    line: { strokeWidth: 2.5, roundCap: false, dots: true },
    showBrush: true,
    waterfall: { connectors: false, signedLabels: false },
  },

  modern: {
    slug: "modern",
    label: "Modern",
    description: "Gradient fills, soft corners and direct labels. Reads like a current product dashboard.",
    bar: {
      radius: 8,
      comboRadius: 8,
      pill: true,
      // Tracks stay on the ranked list only, exactly as classic has them.
      // Extending them to vertical magnitude bars was a mistake worth naming:
      // a track says "X out of a possible Y", and on a revenue-by-outlet chart
      // the track's top is just the rounded-up axis max — a denominator that
      // doesn't exist. It also read as a detached second bar, because a bar
      // fading toward its base is paler than the track behind it.
      track: "list",
      maxBarSize: { vertical: 34, horizontal: 18 },
      categoryGap: { vertical: "32%", horizontal: "30%" },
    },
    // The same stops lineAreaComboRenderers already ships for combo bars. A
    // deeper fade (tried 1 → 0.5) washes the base of the bar out against the
    // card and the bar stops reading as a solid object standing on the axis.
    fill: { gradient: true, stops: [0.95, 0.65] },
    grid: "soft",
    valueAxis: false,
    forceDataLabels: true,
    pie: { cornerRadius: 8, innerRadius: "70%", paddingAngle: 3 },
    treemap: { rx: 10, strokeWidth: 3, monochrome: false },
    area: { strokeWidth: 3, roundCap: true, filled: true, fadeToZero: true },
    line: { strokeWidth: 3, roundCap: true, dots: true },
    showBrush: true,
    waterfall: { connectors: true, signedLabels: false },
  },

  enterprise: {
    slug: "enterprise",
    label: "Enterprise",
    description: "Flat, square and gridless, with the numbers on the marks. The consulting-exhibit look, built for print and board packs.",
    bar: {
      radius: 2,
      comboRadius: 2,
      pill: false,
      // An exhibit is read on paper; a ghost track is a hover affordance with
      // nothing behind it there.
      track: "never",
      maxBarSize: { vertical: 44, horizontal: 16 },
      categoryGap: { vertical: "26%", horizontal: "34%" },
    },
    fill: { gradient: false, stops: [1, 1] },
    grid: "none",
    valueAxis: false,
    forceDataLabels: true,
    pie: { cornerRadius: 0, innerRadius: "62%", paddingAngle: 1 },
    treemap: { rx: 0, strokeWidth: 1.5, monochrome: true },
    // An area fill implies accumulated volume; most series drawn as a line are
    // a rate, so the exhibit form drops the fill rather than implying a total.
    area: { strokeWidth: 2.5, roundCap: true, filled: false, fadeToZero: false },
    line: { strokeWidth: 2, roundCap: true, dots: false },
    showBrush: false,
    waterfall: { connectors: true, signedLabels: true },
  },
};

/**
 * Resolve a chart style by slug. Falls back to "classic" silently for a
 * missing or unknown slug — same contract as resolveTheme(), so a report
 * saved against a preset we later rename still renders instead of throwing.
 */
export function resolveChartStyle(slug: ChartStyle | string | null | undefined): ResolvedChartStyle {
  if (!slug) return CHART_STYLE_PRESETS.classic;
  return (CHART_STYLE_PRESETS as Record<string, ResolvedChartStyle>)[slug] ?? CHART_STYLE_PRESETS.classic;
}
