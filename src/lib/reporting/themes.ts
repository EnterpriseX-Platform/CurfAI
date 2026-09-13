/**
 * Theme presets — the design system source of truth.
 *
 * Every renderer (chart, heatmap, map, KPI sparkline, conditional table cell)
 * must read its colors from a ResolvedTheme. The shape:
 *
 *   palette[]   — categorical series colors (chart Y-fields, treemap cells, …)
 *   ramps.*     — monochromatic 5-stop ramps for intensity (heatmap fills,
 *                 choropleth scales, table heatmap cells)
 *   semantic    — variant tokens (success/warning/danger/info/neutral). These
 *                 do NOT change with theme — meaning is meaning.
 *   typography  — font stacks for heading/body/mono
 *
 * Adding a theme: add to THEME_PRESETS + extend ThemeSchema in schema.ts.
 *
 * Why the ramps are hand-picked rather than generated from palette[0]: HSL
 * rotation gave muddy mid-tones on every theme except Default. Five hand-
 * tuned stops per theme is ~25 lines and makes the choropleth + heatmap +
 * conditional-table-heatmap look like they belong together with the chart
 * series. We can revisit if/when we add user-defined custom palettes.
 */
import type { Theme } from "@/lib/reporting/schema";

export type ThemeRamps = {
  /** 5-stop monochrome ramp from faint to saturated. Indexed 0..4. */
  primary: string[];
};

export type ThemeSemantic = {
  success: string;
  warning: string;
  danger:  string;
  info:    string;
  neutral: string;
};

export type ResolvedTheme = {
  slug: Theme;
  label: string;
  description: string;
  /** 10-color categorical palette for chart series. */
  palette: string[];
  /** Monochrome ramps for intensity-based visualisations. */
  ramps: ThemeRamps;
  /** Variant tokens (theme-invariant). */
  semantic: ThemeSemantic;
  /** CSS font-family stack for headings / body / mono. */
  fonts: { heading: string; body: string; mono: string };
  /** Accent color for chrome (theme picker swatch, brand affordances). */
  swatch: string;
};

/**
 * Theme-invariant semantic tokens. Even on Sunset, a "danger" cell stays
 * red — we don't want the variant scale to shift just because the chart
 * palette did. These are referenced via theme.semantic.* but identical
 * across all presets.
 */
// Same hexes as the app-chrome tokens (--success / --warning / --destructive
// / --primary / --faint in globals.css), so a KPI card's token-coloured delta
// pill and its theme.semantic-coloured sparkline are the same green.
const SEMANTIC: ThemeSemantic = {
  success: "#0E7C5B",
  warning: "#A8690F",
  danger:  "#B4304A",
  info:    "#3B37D1",
  neutral: "#8A90A3",
};

const FONT_SANS = '"Instrument Sans", Prompt, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const FONT_MONO  = '"IBM Plex Mono", Prompt, ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

export const THEME_PRESETS: Record<Theme, ResolvedTheme> = {
  default: {
    slug: "default",
    label: "Default",
    description: "Curf's indigo brand look. Works for almost anything.",
    palette: [
      "#6366f1", "#10b981", "#f59e0b", "#f43f5e", "#06b6d4",
      "#8b5cf6", "#0ea5e9", "#ec4899", "#f97316", "#84cc16",
    ],
    ramps: {
      // indigo 100 → 700, eased
      primary: ["#eef2ff", "#c7d2fe", "#818cf8", "#4f46e5", "#3730a3"],
    },
    semantic: SEMANTIC,
    fonts: { heading: FONT_SANS, body: FONT_SANS, mono: FONT_MONO },
    swatch: "#6366f1",
  },
  sunset: {
    slug: "sunset",
    label: "Sunset",
    description: "Warm rose / amber. Marketing, creative, brand reports.",
    palette: [
      "#f43f5e", "#f59e0b", "#ec4899", "#fb923c", "#d946ef",
      "#fbbf24", "#f97316", "#e11d48", "#c026d3", "#fb7185",
    ],
    ramps: {
      // rose 50 → 700, slightly deepened to keep contrast on white
      primary: ["#fff1f2", "#fecdd3", "#fb7185", "#e11d48", "#9f1239"],
    },
    semantic: SEMANTIC,
    fonts: {
      heading: '"DM Sans", ' + FONT_SANS,
      body: FONT_SANS,
      mono: FONT_MONO,
    },
    swatch: "#f43f5e",
  },
  forest: {
    slug: "forest",
    label: "Forest",
    description: "Cool emerald & teal. ESG, sustainability, ops.",
    palette: [
      "#10b981", "#059669", "#65a30d", "#0d9488", "#84cc16",
      "#14b8a6", "#22c55e", "#15803d", "#a3e635", "#34d399",
    ],
    ramps: {
      // emerald 50 → 700
      primary: ["#ecfdf5", "#a7f3d0", "#34d399", "#059669", "#065f46"],
    },
    semantic: SEMANTIC,
    fonts: {
      heading: '"Source Sans 3", ' + FONT_SANS,
      body: FONT_SANS,
      mono: FONT_MONO,
    },
    swatch: "#10b981",
  },
  midnight: {
    slug: "midnight",
    label: "Midnight",
    description: "Slate, cyan, violet. Finance & governance.",
    palette: [
      "#475569", "#0891b2", "#7c3aed", "#1d4ed8", "#0e7490",
      "#5b21b6", "#0284c7", "#312e81", "#155e75", "#6d28d9",
    ],
    ramps: {
      // slate→indigo blend for the choropleth
      primary: ["#f1f5f9", "#cbd5e1", "#64748b", "#334155", "#1e293b"],
    },
    semantic: SEMANTIC,
    fonts: {
      heading: '"IBM Plex Sans", ' + FONT_SANS,
      body: FONT_SANS,
      mono: FONT_MONO,
    },
    swatch: "#1d4ed8",
  },
  candy: {
    slug: "candy",
    label: "Candy",
    description: "High-contrast pop. Consumer dashboards, growth.",
    palette: [
      "#ec4899", "#3b82f6", "#22c55e", "#eab308", "#a855f7",
      "#06b6d4", "#f97316", "#ef4444", "#14b8a6", "#8b5cf6",
    ],
    ramps: {
      // pink/fuchsia
      primary: ["#fdf2f8", "#fbcfe8", "#f472b6", "#db2777", "#9d174d"],
    },
    semantic: SEMANTIC,
    fonts: {
      heading: '"Plus Jakarta Sans", ' + FONT_SANS,
      body: FONT_SANS,
      mono: FONT_MONO,
    },
    swatch: "#ec4899",
  },
  boardroom: {
    slug: "boardroom",
    label: "Boardroom",
    description: "Signal blue, graphite and teal. Board packs, exhibits, print.",
    /**
     * The colour half of the consulting-exhibit look — pair it with the
     * "enterprise" chart style (lib/reporting/chartStyles.ts) for the full
     * treatment. Kept as a theme rather than baked into that style because
     * the two axes stay orthogonal: a workspace can want this palette on
     * Modern charts, or its own brand colours in Enterprise form.
     *
     * Why this ISN'T led by a deep consulting navy, which is the obvious
     * choice and was the first attempt: a chart series is a large filled
     * shape, and these fills render on BOTH the white card and the dark one.
     * Measured against the dark `--card` token, a true navy is invisible —
     * #051C2C scores 1.07:1 and even a mid #1B3A6B only 1.44:1, well under
     * the 3:1 that non-text content needs. There is no navy dark enough to
     * read as an exhibit in print that also survives dark mode, so the lead
     * is a signal blue instead and the deep navy lives on in `ramps.primary`,
     * where a dark end is the whole point of a sequential scale.
     *
     * Every entry clears 3:1 on both grounds and is at least ΔE 19 from every
     * other, with the first three ΔE 38 apart — an exhibit rarely plots more
     * than three or four series, so the separation budget is spent on the
     * ones that actually get used, and the calmest colours lead. Both
     * properties are guarded in themes.test.ts.
     *
     * Distance is measured in Lab, not hue: the first two entries sit only
     * ~5° apart in hue and are still obviously different, because one is a
     * vivid blue and the other a desaturated slate. A hue-gap check rejects
     * that legitimate pair while happily passing two colours that differ in
     * hue but read identically once desaturated.
     */
    palette: [
      "#3E75DA", "#6A6388", "#369FAB", "#1C6E92", "#7894B0",
      "#516D70", "#6B77BD", "#3A9AD9", "#725CCC", "#684BDD",
    ],
    ramps: {
      // navy 50 → 900, for choropleth / heatmap intensity
      primary: ["#EAF0F8", "#C3D3E8", "#7C9BC4", "#3B6398", "#1B3A6B"],
    },
    semantic: SEMANTIC,
    // No new font family: the CSP is font-src 'self' and only the faces wired
    // through next/font in layout.tsx actually load.
    fonts: { heading: FONT_SANS, body: FONT_SANS, mono: FONT_MONO },
    swatch: "#4378DB",
  },
};

/**
 * Resolve a theme by slug. Falls back to "default" silently when the slug
 * is missing or unknown — keeps old reports valid as we add/rename themes
 * without throwing on render.
 */
export function resolveTheme(slug: Theme | string | null | undefined): ResolvedTheme {
  if (!slug) return THEME_PRESETS.default;
  return (THEME_PRESETS as Record<string, ResolvedTheme>)[slug] ?? THEME_PRESETS.default;
}

/** Convenience: just the categorical palette. */
export function paletteFor(slug: Theme | string | null | undefined): string[] {
  return resolveTheme(slug).palette;
}

/**
 * Map a "ramp" enum slug (used today on Heatmap/Map block configs:
 * "primary"|"emerald"|"amber"|"rose"|"cyan") to actual hex colors.
 *
 * - "primary" routes through the *theme's* primary ramp so the heatmap and
 *   choropleth follow the report theme.
 * - The other slugs are semantic shortcuts (emerald = success-ish ramp,
 *   rose = danger-ish ramp) and stay theme-invariant.
 *
 * Returns the saturated end of the ramp; consumers that need the full
 * 5-stop ramp can call `resolveTheme(theme).ramps.primary` directly.
 */
const FIXED_RAMPS: Record<string, string[]> = {
  emerald: ["#ecfdf5", "#a7f3d0", "#34d399", "#059669", "#065f46"],
  amber:   ["#fffbeb", "#fde68a", "#fbbf24", "#d97706", "#92400e"],
  rose:    ["#fff1f2", "#fecdd3", "#fb7185", "#e11d48", "#9f1239"],
  cyan:    ["#ecfeff", "#a5f3fc", "#22d3ee", "#0891b2", "#155e75"],
};

export function rampFor(
  themeSlug: Theme | string | null | undefined,
  rampSlug: string | undefined,
): string[] {
  const slug = rampSlug ?? "primary";
  if (slug === "primary") return resolveTheme(themeSlug).ramps.primary;
  return FIXED_RAMPS[slug] ?? resolveTheme(themeSlug).ramps.primary;
}
