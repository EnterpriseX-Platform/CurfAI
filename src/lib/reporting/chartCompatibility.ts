/**
 * Chart-type compatibility engine.
 *
 * Single source of truth for two related questions, shared by the manual
 * Designer (ChartTypeSelector, ChartTypeField), Master Builder's chat-patch
 * chart-type edits, and AutoCurf's chart-type selection:
 *
 *   1. Given a query's actual result rows, what shape is each column
 *      (numeric / date / categorical / text)?
 *   2. Given that shape plus a block's current xField/yFields/sizeField,
 *      which of the 12 chartType values would actually render something —
 *      and for the ones that wouldn't, why not?
 *
 * No Node-only imports (mirrors interpolate.ts) so it's safe to import from
 * client components as well as server-side appliers.
 */
import type { Row } from "./interpolate";

export type ColumnKind = "numeric" | "date" | "categorical" | "text";

export type ColumnProfile = {
  name: string;
  kind: ColumnKind;
  hasData: boolean;
  distinctCount: number;
};

/** Same categorical threshold AutoCurf's classifyColumns() uses, for consistency. */
const CATEGORICAL_MAX_DISTINCT = 20;
/** Cap how many rows we scan — profiling is a UI-time convenience, not a query. */
const SAMPLE_CAP = 200;

const DATE_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}$/,      // 2026-08-28
  /^\d{4}-\d{2}$/,            // 2026-08
  /^\d{4}-Q[1-4]$/,           // 2026-Q3
  /^\d{4}$/,                  // 2026
];

function looksLikeDate(v: string): boolean {
  if (DATE_PATTERNS.some((re) => re.test(v))) return true;
  // Longer date-ish strings only — bare short strings ("N/A", "Bar") would
  // otherwise round-trip through Date.parse as garbage/invalid-but-truthy.
  if (v.length >= 8 && /[-/]/.test(v) && !isNaN(Date.parse(v))) return true;
  return false;
}

/**
 * Infer each column's shape from sampled row *values* — there is no
 * declared schema for an arbitrary SQL/REST query result at render time
 * (unlike AutoCurf's Lake-table classifyColumns(), which reads declared
 * LakeColumn types). Thresholds intentionally match classifyColumns() so
 * the two don't disagree on the same data.
 */
export function profileColumns(rows: Row[]): Record<string, ColumnProfile> {
  const sample = rows.slice(0, SAMPLE_CAP);
  const columns = new Set<string>();
  for (const r of sample) for (const k of Object.keys(r ?? {})) columns.add(k);

  const out: Record<string, ColumnProfile> = {};
  for (const name of columns) {
    const values = sample
      .map((r) => r?.[name])
      .filter((v) => v != null && v !== "");

    if (values.length === 0) {
      out[name] = { name, kind: "text", hasData: false, distinctCount: 0 };
      continue;
    }

    const allNumeric = values.every((v) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))));
    if (allNumeric) {
      out[name] = { name, kind: "numeric", hasData: true, distinctCount: -1 };
      continue;
    }

    const allDates = values.every((v) => typeof v === "string" && looksLikeDate(v));
    if (allDates) {
      out[name] = { name, kind: "date", hasData: true, distinctCount: -1 };
      continue;
    }

    const distinct = new Set(values.map((v) => String(v)));
    const kind: ColumnKind = distinct.size > 0 && distinct.size <= CATEGORICAL_MAX_DISTINCT ? "categorical" : "text";
    out[name] = { name, kind, hasData: true, distinctCount: distinct.size };
  }
  return out;
}

export type ChartPurpose = "composition" | "comparison" | "distribution" | "relationship" | "trend" | "flow" | "geospatial";

export type ChartTypeValue =
  | "bar" | "line" | "area" | "pie" | "donut" | "combo"
  | "treemap" | "funnel" | "scatter" | "radar" | "gauge" | "waterfall" | "bullet"
  | "sunburst" | "sankey" | "streamgraph"
  | "boxplot" | "network" | "chord" | "parallel" | "radial" | "scatter3d";

export type ChartFieldConfig = {
  xField?: string;
  yFields?: string[];
  sizeField?: string;
  /** Sunburst only — see ChartConfigSchema.hierarchyFields. */
  hierarchyFields?: string[];
  /** Sankey only — see ChartConfigSchema.targetField. */
  targetField?: string;
  /** 3D scatter only — see ChartConfigSchema.zField. */
  zField?: string;
};

/**
 * `reasonKey` is a lib/i18n/dict.ts key (chartEligibility.*): the pickers show
 * t(reasonKey); server-side text (Master Builder) resolves DICT.en.
 */
export type EligibilityResult = { eligible: true } | { eligible: false; reasonKey: string };

function isNumericField(profiles: Record<string, ColumnProfile>, field: string | undefined): boolean {
  if (!field) return false;
  const p = profiles[field];
  return !!p && p.kind === "numeric" && p.hasData;
}

function hasAnyNumericYField(profiles: Record<string, ColumnProfile>, yFields: string[] | undefined): boolean {
  return !!yFields?.some((f) => isNumericField(profiles, f));
}

/**
 * Per-type eligibility check. Deliberately checks only conditions that would
 * make the chart render empty/broken (no numeric measure, missing required
 * field) — not stylistic fit (e.g. "too many pie slices"). Business-purpose
 * ranking for *recommending* a type lives in rankChartTypes(), below.
 */
export function checkChartTypeEligibility(
  type: ChartTypeValue,
  config: ChartFieldConfig,
  profiles: Record<string, ColumnProfile>,
): EligibilityResult {
  if (Object.keys(profiles).length === 0) {
    return { eligible: false, reasonKey: "chartEligibility.noData" };
  }

  const needsX = () => (config.xField ? null : { eligible: false as const, reasonKey: "chartEligibility.needsX" });
  const needsNumericY = () =>
    hasAnyNumericYField(profiles, config.yFields)
      ? null
      : { eligible: false as const, reasonKey: "chartEligibility.needsNumericY" };

  switch (type) {
    case "bar":
    case "line":
    case "area":
    case "combo":
    case "pie":
    case "donut":
    case "treemap":
    case "funnel":
    case "waterfall":
    case "radar":
      return needsX() ?? needsNumericY() ?? { eligible: true };

    case "streamgraph":
      return needsX() ?? needsNumericY() ?? { eligible: true };

    case "scatter3d":
      // Three measures: x, the first yField, and zField, all numeric.
      if (!isNumericField(profiles, config.xField) || !isNumericField(profiles, config.zField)) {
        return { eligible: false, reasonKey: "chartEligibility.needsThreeNumeric" };
      }
      return needsNumericY() ?? { eligible: true };

    case "scatter": {
      if (!isNumericField(profiles, config.xField)) {
        return { eligible: false, reasonKey: "chartEligibility.scatterNumericX" };
      }
      return needsNumericY() ?? { eligible: true };
    }

    case "sunburst": {
      // Falls back to a single ring keyed by xField when hierarchyFields
      // isn't set — same zero-extra-config bar every other chart type
      // clears, so Sunburst is usable immediately without a dedicated
      // multi-level editor (see hierarchyFields' doc comment in schema.ts).
      const hasLevels = (config.hierarchyFields?.length ?? 0) > 0 || !!config.xField;
      if (!hasLevels) return { eligible: false, reasonKey: "chartEligibility.needsGrouping" };
      return needsNumericY() ?? { eligible: true };
    }

    case "sankey": {
      if (!config.xField || !config.targetField) {
        return { eligible: false, reasonKey: "chartEligibility.needsSourceTarget" };
      }
      return needsNumericY() ?? { eligible: true };
    }

    case "boxplot":
    case "radial":
      return needsX() ?? needsNumericY() ?? { eligible: true };

    case "network":
    case "chord":
      // The weight may be a count of rows, so any yField will do.
      if (!config.xField || !config.targetField) {
        return { eligible: false, reasonKey: "chartEligibility.needsSourceTarget" };
      }
      return { eligible: true };

    case "parallel": {
      const numeric = (config.yFields ?? []).filter((f) => isNumericField(profiles, f)).length;
      return numeric >= 2 ? { eligible: true } : { eligible: false, reasonKey: "chartEligibility.needsTwoNumeric" };
    }

    case "gauge":
    case "bullet": {
      // Single-value chart types: only the first yField is used as the
      // metric. xField is ignored, so it isn't part of eligibility here.
      const first = config.yFields?.[0];
      return isNumericField(profiles, first)
        ? { eligible: true }
        : { eligible: false, reasonKey: "chartEligibility.needsSingleNumeric" };
    }

    default:
      return { eligible: true };
  }
}

/**
 * Display names live in lib/i18n/dict.ts, not here: chartType.<value> for the
 * type and chartPurpose.<purpose> for its group heading, in all three locales
 * (chartCompatibility.test.ts checks). A new chart type needs both.
 */
export type ChartTypeMeta = {
  value: ChartTypeValue;
  purpose: ChartPurpose;
  /** One-line "when to use" guidance — also fed to Master Builder / AutoCurf prompts. */
  whenToUse: string;
};

export const CHART_TYPE_META: ChartTypeMeta[] = [
  { value: "bar", purpose: "comparison",
    whenToUse: "Compare a numeric value across categories, or rank them." },
  { value: "line", purpose: "trend",
    whenToUse: "Show how a numeric value changes over time or an ordered sequence." },
  { value: "area", purpose: "trend",
    whenToUse: "Trend over time with emphasis on cumulative volume under the line." },
  { value: "combo", purpose: "trend",
    whenToUse: "Two related measures on different scales over time, e.g. revenue (bars) and margin % (line)." },
  { value: "pie", purpose: "composition",
    whenToUse: "A few categories (ideally ≤ 6) that sum to a meaningful whole." },
  { value: "donut", purpose: "composition",
    whenToUse: "Same as Pie, with the center free for a total/KPI label." },
  { value: "treemap", purpose: "composition",
    whenToUse: "Composition across many categories (more than a pie can read) sized by a numeric value." },
  { value: "sunburst", purpose: "composition",
    whenToUse: "Composition with nested levels, e.g. region -> country -> city — like a Donut that can go multiple rings deep." },
  { value: "funnel", purpose: "flow",
    whenToUse: "An ordered process with drop-off at each stage, e.g. a conversion funnel." },
  { value: "waterfall", purpose: "flow",
    whenToUse: "A running total bridged by sequential positive/negative deltas, e.g. a P&L bridge." },
  { value: "sankey", purpose: "flow",
    whenToUse: "Flow of a quantity between stages, e.g. budget by department or a multi-step customer path — needs a source and a target column." },
  { value: "streamgraph", purpose: "trend",
    whenToUse: "Like a stacked area chart but flowing/organic — shows how the mix of several series shifts over time." },
  { value: "scatter", purpose: "relationship",
    whenToUse: "Whether two numeric measures correlate; add a size field for a bubble chart." },
  { value: "radar", purpose: "comparison",
    whenToUse: "Compare 2+ entities across several dimensions at once, e.g. products scored on quality/price/support." },
  { value: "gauge", purpose: "comparison",
    whenToUse: "One KPI value against a target/zone band, at a glance." },
  { value: "bullet", purpose: "comparison",
    whenToUse: "Same as Gauge, in a compact bar — good for stacking several KPIs in a list." },
  { value: "boxplot", purpose: "distribution",
    whenToUse: "How a measure spreads within each category — median, quartiles and outliers, e.g. unit cost by work type. Reads raw rows, not totals." },
  { value: "radial", purpose: "distribution",
    whenToUse: "A measure round a cycle — hours of the day, days of the week, months — so the busy and quiet stretches read as a clock face." },
  { value: "parallel", purpose: "relationship",
    whenToUse: "Every row across 3-7 numeric measures at once, one line each, coloured by a category — spot the rows that are off on several checks together." },
  { value: "network", purpose: "relationship",
    whenToUse: "Which items are linked and how tightly — overlapping requests, products bought together — needs a source and a target column." },
  { value: "scatter3d", purpose: "relationship",
    whenToUse: "Three measures of the same rows at once, turned in 3D — e.g. cost against reference, readiness and size per request — needs a third numeric column (zField); colour by a category." },
  { value: "chord", purpose: "flow",
    whenToUse: "Flows between a handful of groups in both directions, round a circle — e.g. which categories are bought together — needs a source and a target column." },
];

const META_BY_VALUE: Record<ChartTypeValue, ChartTypeMeta> = Object.fromEntries(
  CHART_TYPE_META.map((m) => [m.value, m]),
) as Record<ChartTypeValue, ChartTypeMeta>;

export function getChartTypeMeta(type: ChartTypeValue): ChartTypeMeta {
  return META_BY_VALUE[type];
}

export type RankedChartType = ChartTypeMeta & EligibilityResult & { score: number };

/**
 * Rank all 12 chart types for a given field config + column profiles.
 * Ineligible types always sort last. Among eligible types, an optional
 * purpose hint (e.g. "the report is about a trend over time") boosts
 * matching types — this is what lets Master Builder / AutoCurf recommend
 * the *best* type, not just any type that would technically render.
 */
export function rankChartTypes(
  config: ChartFieldConfig,
  profiles: Record<string, ColumnProfile>,
  purposeHint?: ChartPurpose,
): RankedChartType[] {
  return CHART_TYPE_META
    .map((meta) => {
      const result = checkChartTypeEligibility(meta.value, config, profiles);
      const score = result.eligible ? (purposeHint && meta.purpose === purposeHint ? 2 : 1) : 0;
      return { ...meta, ...result, score };
    })
    .sort((a, b) => b.score - a.score);
}
