/**
 * Report JSON schema. The single source of truth for what a report is.
 *
 * Every block type has its own config schema registered in BlockConfigSchemas.
 * Adding a new block type = (1) add config schema here, (2) add React component
 * in src/components/blocks/, (3) add renderer hooks in the export pipelines.
 */
import { z } from "zod";
import { assertSelectOnly } from "./sqlGuard";

// ---------- Parameters ----------

export const ParameterSchema = z.object({
  name: z.string().min(1),
  label: z.string(),
  type: z.enum(["string", "number", "date", "dateRange", "boolean", "select"]),
  required: z.boolean().default(false),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
});
export type Parameter = z.infer<typeof ParameterSchema>;

// ---------- Data sources (named queries within a report) ----------

/**
 * A named query inside a report. Two shapes, picked at runtime by the
 * kind of the DataSource row it points at:
 *   - SQL sources (sqlite/postgres/...): use sql with :param placeholders.
 *   - REST sources: use method/path (with :param in path), optional body
 *     template (JSON string with {{param.x}} tokens), and jsonPath to pluck
 *     the rows array out of the response (e.g. "$.data.items").
 * Only the fields relevant to the chosen kind need to be set; others are ignored.
 */
export const DataSourceDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  dataSourceId: z.string(),
  // SQL kinds
  sql: z.string().optional(),
  /**
   * Marks the trailing `LIMIT n` on this query as a *display* cap that the
   * generator applied to keep the page fast — not a limit the report author
   * asked for.
   *
   * Exports lift it, because a file that claims to hold the table but stops
   * at row 500 is simply wrong. A hand-written query with its own LIMIT
   * carries no such marker and is always honoured verbatim: the author
   * meant it.
   */
  previewLimit: z.number().int().positive().optional(),
  // REST kind
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  path: z.string().optional(),
  body: z.string().optional(),
  jsonPath: z.string().optional(),
  headers: z.record(z.string()).optional(),
  /**
   * Cross-source JOINs (Tier 1 — SQLite ATTACH DATABASE).
   *
   * Optional list of foreign DataSources to ATTACH onto this query's primary
   * connection. Only meaningful when the primary kind is "sqlite" or "excel"
   * (both are SQLite files under the hood); attaches against a REST primary
   * are rejected by the runner.
   *
   * Each entry binds a foreign DataSource id to a SQL alias the query can
   * reference, e.g. `FROM main.campaigns c JOIN excel_kpis.monthly_kpis k ON …`.
   *
   * The runner enforces the same visibility ACL on every attached source —
   * a viewer who can't see the foreign DataSource gets the same empty-rows
   * + access-denied note as if the primary itself were hidden.
   *
   * Aliases must be valid SQL identifiers and cannot be "main" or "temp"
   * (SQLite-reserved). Validated again at runtime; this regex is the cheap
   * up-front gate.
   */
  attaches: z.array(z.object({
    dataSourceId: z.string().min(1),
    alias: z.string().regex(/^(?!main$|temp$)[a-z_][a-z0-9_]*$/i, "alias must be a SQL identifier and not 'main' / 'temp'"),
  })).optional(),
  /**
   * Cross-source JOINs (Tier 2 — in-runner hash join across heterogeneous
   * connector kinds). Distinct from `attaches[]`:
   *
   *   attaches[]: SQLite ATTACH DATABASE under one engine. File-backed only
   *               (sqlite + excel). Free-form SQL, including multi-table JOINs.
   *               Tier 1 — see runner.ts runOnSqlite ATTACH path.
   *
   *   joins[]:    The runner runs the primary query AND each referenced
   *               sibling query (any kind) independently, then merges rows
   *               in Node via hashJoin(). Slower than ATTACH but works
   *               across postgres/rest/sqlite/excel uniformly.
   *
   * Each entry references another DataSourceDef in the same report by id.
   * Cycle detection lives in the runner — A.joins[B] + B.joins[A] is rejected.
   *
   * Output rows merge primary fields with prefixed sibling fields:
   *   { id, customer_id, amount, c__id, c__name, c__region }
   *
   * Aliases follow the same identifier rules as attaches[]: lowercase, no
   * digit-leading, not "main" / "temp" (we use the alias both as column
   * prefix and as the provenance display tag).
   */
  joins: z.array(z.object({
    type: z.enum(["left", "inner"]),
    queryId: z.string().min(1),
    on: z.object({
      left: z.string().min(1),
      right: z.string().min(1),
    }),
    alias: z.string().regex(/^(?!main$|temp$)[a-z_][a-z0-9_]*$/i, "alias must be a SQL identifier and not 'main' / 'temp'"),
  })).optional(),
}).refine(
  (ds) => {
    if (!ds.sql) return true;
    try {
      assertSelectOnly(ds.sql);
      return true;
    } catch {
      return false;
    }
  },
  // Defense-in-depth: the runner already rejects write/DDL SQL at *execution*
  // time, but a report could previously be *saved* with e.g. a DROP TABLE
  // sitting in its definition until someone ran it — a landmine, and it also
  // let a compromised editor-role account stash arbitrary SQL indefinitely.
  // Rejecting at save time (here, via ReportSchema.safeParse) closes that gap
  // for every route that persists a report definition, in one place.
  { message: "SQL data sources may only contain a read-only SELECT (or WITH ... SELECT) statement", path: ["sql"] },
);
export type DataSourceDef = z.infer<typeof DataSourceDefSchema>;

export const TopKpiDefSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** Plain-language explanation of what this KPI measures — shown to the
   *  business user in place of the raw SQL in `query.sql`, which is an
   *  implementation detail, not something a non-technical viewer should
   *  have to read to understand the metric. */
  description: z.string().optional(),
  query: DataSourceDefSchema,
  format: z.enum(["number", "currency", "percent"]).default("number"),
});
export type TopKpiDef = z.infer<typeof TopKpiDefSchema>;

// ---------- Block config schemas ----------

export const TitleConfigSchema = z.object({
  text: z.string().default("Untitled"),
  subtitle: z.string().optional(),
  align: z.enum(["left", "center", "right"]).default("left"),
});

export const TextConfigSchema = z.object({
  text: z.string().default(""),
  align: z.enum(["left", "center", "right"]).default("left"),
  size: z.enum(["sm", "md", "lg"]).default("md"),
});

/**
 * Conditional formatting rule (Tier 1.6 — viz.conditional_table, Team).
 *
 * Three modes:
 *   - heatmap: cell background color scales with value across the column's
 *     min..max range. Default ramp is primary; can be flipped (good=low).
 *   - bar: a horizontal mini-bar drawn behind the cell text, sized to the
 *     value's share of the column max. Numeric columns only.
 *   - threshold: explicit rules (>, <, =, >=, <=, between) that pick a
 *     variant color for matching cells. Multiple rules = first match wins.
 *
 * All three are independent — a column can have heatmap + threshold layered
 * if desired. Threshold rules win the foreground/background; heatmap dims
 * to a softer fill underneath.
 */
/**
 * Curated icon set rendered as Lucide SVG strokes — the premium indicator
 * set used inside conditional rules + chart annotations. Always render at
 * 12px / stroke-1.75 / variant-matched color so they read as the same icon
 * family across every viewer. "auto" maps from the variant
 * (success → CheckCircle, danger → XCircle, etc) so you don't have to
 * pick one.
 *
 * The `icon` string field is kept as a power-user escape hatch (custom
 * emoji or text) but defaults to off — emoji are intentionally NOT used
 * in the default render path because they look toy-grade across OSes.
 */
export const VariantIconKind = z.enum([
  "auto",      // map from variant: success→check, danger→x, warning→triangle, …
  "check",     // CheckCircle2
  "warning",   // AlertTriangle
  "alert",     // XCircle / AlertOctagon
  "info",      // Info
  "arrowUp",   // ArrowUpRight
  "arrowDown", // ArrowDownRight
  "minus",     // MinusCircle
  "star",      // Star
  "flag",      // Flag
  "sparkle",   // Sparkles
  "none",      // explicit "no icon"
]);
export type VariantIconKindT = z.infer<typeof VariantIconKind>;

export const ConditionalRuleSchema = z.object({
  op: z.enum(["gt", "gte", "lt", "lte", "eq", "between"]),
  /** Single threshold for unary ops, or low end of range for `between`. */
  value: z.number(),
  /** High end of range for `between`. Ignored otherwise. */
  value2: z.number().optional(),
  variant: z.enum(["success", "warning", "danger", "info", "neutral"]).default("info"),
  /**
   * Curated SVG icon. Set to "auto" to get a variant-matched Lucide
   * stroke icon (CheckCircle2 for success, XCircle for danger, …). Set
   * to "none" to suppress entirely. Left optional so legacy reports
   * authored before iconKind existed keep their original look (rendered
   * via the `icon` string below).
   *
   * Precedence at render time (see VariantIcon):
   *   iconKind set     → curated SVG (takes priority over legacy `icon`)
   *   iconKind unset + icon set → render the `icon` string verbatim
   *   neither          → no icon
   */
  iconKind: VariantIconKind.optional(),
  /**
   * Legacy free-form icon string (emoji or text). Predates iconKind.
   * Kept for backward compat — emoji aren't used in the default render
   * path because they look toy-grade across OSes. New configs should
   * prefer iconKind: "auto".
   */
  icon: z.string().optional(),
});
export type ConditionalRule = z.infer<typeof ConditionalRuleSchema>;

export const ConditionalFormatSchema = z.object({
  /** Heatmap shading across the column's min..max. */
  heatmap: z.enum(["off", "primary", "diverging", "good-bad", "bad-good"]).default("off"),
  /** Inline data bar in the cell behind the text. */
  bar: z.boolean().default(false),
  /** Explicit threshold rules. First match wins. */
  rules: z.array(ConditionalRuleSchema).default([]),
});
export type ConditionalFormat = z.infer<typeof ConditionalFormatSchema>;

export const TableColumnSchema = z.object({
  key: z.string(),
  label: z.string(),
  /**
   * `formula` is a virtual column: its value is computed from a
   * spreadsheet-style expression (`=spend / leads`, `=IF(roi > 3, "OK", "low")`)
   * evaluated per row against the dataset. Doesn't read row[key] — `key`
   * is only used as the column's React key + the formula's referencable
   * column name (so other formulas can reference this one).
   */
  type: z.enum(["string", "number", "currency", "percent", "date", "datetime", "formula"]).default("string"),
  align: z.enum(["left", "center", "right"]).optional(),
  total: z.enum(["none", "sum", "avg", "count", "min", "max"]).default("none"),
  format: z.string().optional(),
  /** Optional conditional formatting (Team+). */
  conditional: ConditionalFormatSchema.optional(),
  /**
   * Spreadsheet-style formula. Required when type === "formula". May
   * begin with "=" for Excel-familiarity. Examples:
   *   "=spend / leads"
   *   "=IF(roi > 3, 'great', 'low')"
   *   "=ROUND(spend / SUM(spend) * 100, 1)"
   * Available helpers: SUM/AVG/MIN/MAX/MEDIAN/COUNT/COUNTA over column
   * names, IF/AND/OR/NOT, ABS/ROUND/CEIL/FLOOR/SQRT, LEN/LOWER/UPPER/
   * TRIM/CONCAT. Sandboxed via expr-eval — no JS escape.
   */
  formula: z.string().optional(),
  /**
   * For formula columns, the format used when displaying the result.
   * Falls back to "number" when omitted.
   */
  formulaFormat: z.enum(["number", "currency", "percent", "string"]).optional(),
});
export type TableColumn = z.infer<typeof TableColumnSchema>;

export const TableActionSchema = z.object({
  id: z.string(),
  label: z.string().min(1),
  icon: z.string().optional(),
  /**
   * Dispatcher kind.
   *   log     - records an ActionRun with the row payload (demo-friendly, no side effects).
   *   webhook - POSTs JSON to an external URL.
   *   email   - stub for SMTP/Resend integration (enterprise).
   */
  kind: z.enum(["log", "webhook", "email"]).default("log"),
  /** Interpolation template for dispatcher payload. Uses {{row.field}} syntax. */
  config: z.record(z.string()).default({}),
  /** Require a confirm dialog before dispatching (default true). */
  confirm: z.boolean().default(true),
  confirmLabel: z.string().optional(),
});
export type TableAction = z.infer<typeof TableActionSchema>;

export const TableConfigSchema = z.object({
  queryId: z.string(),
  title: z.string().optional(),
  columns: z.array(TableColumnSchema).default([]),
  pageSize: z.number().int().positive().max(1000).default(50),
  stripe: z.boolean().default(true),
  showTotals: z.boolean().default(true),
  actions: z.array(TableActionSchema).default([]),
});

/**
 * Forecast projection config (Tier 4 — ai.forecast_linear / ai.forecast_llm).
 * Shared by chart blocks (line / area / combo / bar) and the KPI sparkline —
 * same shape either way since the projection math is series-length-agnostic.
 *
 * - method "linear" — pure-JS OLS, gated ai.forecast_linear (Team)
 * - method "ets"     — pure-JS Holt's exponential smoothing, same gate as
 *                       "linear" (also deterministic, no LLM cost) — reacts
 *                       faster to a recent trend change than a single OLS
 *                       line does; see exponentialSmoothingFit in forecast.ts
 * - method "llm"    — Claude-based projection, gated ai.forecast_llm
 *                     (Business). Renderer falls back to linear if the
 *                     LLM call fails so the chart never goes blank.
 */
export const ForecastConfigSchema = z.object({
  method:    z.enum(["linear", "ets", "llm"]).default("linear"),
  periods:   z.number().int().min(1).max(24).default(4),
  showBands: z.boolean().default(true),
});
export type ForecastConfig = z.infer<typeof ForecastConfigSchema>;

export const KpiConfigSchema = z.object({
  queryId: z.string(),
  label: z.string().default("Metric"),
  valueField: z.string(),
  format: z.enum(["number", "currency", "percent"]).default("number"),
  compareField: z.string().optional(),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
  /**
   * Client-side aggregation across ALL rows of the dataset. Use when the
   * underlying query returns a list (typical for REST sources or when the
   * SQL author hasn't pre-aggregated). "count" ignores valueField and
   * returns the row count.
   */
  aggregate: z.enum(["sum", "avg", "count", "min", "max"]).optional(),
  /**
   * Optional sparkline. Points to a query that returns a time-series of
   * values; the renderer draws a compact line under the headline number.
   *
   *   sparkQueryId  - data source for the spark series (separate query so
   *                   the KPI's value query can stay simple)
   *   sparkValueField - numeric column to plot
   *   sparkPositive  - "up" means rising = good (default), "down" means
   *                   rising = bad (flips the color)
   */
  sparkQueryId: z.string().optional(),
  sparkValueField: z.string().optional(),
  sparkPositive: z.enum(["up", "down"]).optional(),
  /** Optional forecast projection appended to the sparkline tail — see ForecastConfigSchema. */
  forecast: ForecastConfigSchema.optional(),
});

/**
 * Drill-through config. When present on a chart (or KPI) block, clicking a
 * data point in the viewer opens a slide-out panel listing the underlying
 * rows that produced that aggregate value.
 *
 * The handler runs `queryId` server-side and binds `filterParam` to the
 * clicked dimension value (e.g. clicking the "Email" bar binds
 * filterParam="channel" to "Email"). The query author is responsible for
 * referencing :filterParam in their SQL — the runner already substitutes
 * named parameters, so no additional plumbing is needed.
 */
export const DrillThroughSchema = z.object({
  queryId: z.string(),
  filterParam: z.string(),
  /** Title displayed at the top of the slide-out panel. */
  title: z.string().optional(),
});
export type DrillThrough = z.infer<typeof DrillThroughSchema>;

/**
 * Optional reference line drawn across the plot area (target, threshold,
 * average, etc). Tooltip-style annotation included automatically.
 */
export const ReferenceLineSchema = z.object({
  axis: z.enum(["x", "y"]).default("y"),
  value: z.number(),
  label: z.string().optional(),
  /** "warning" / "success" / "neutral" — picks the stroke color. */
  variant: z.enum(["warning", "success", "neutral", "danger"]).default("neutral"),
});

/**
 * Event annotation. A vertical marker at a specific x-value with a label —
 * used to call out things like "Campaign launch", "Holiday weekend",
 * "Outage", "Pricing change" on a time-series chart.
 *
 * `xValue` is a string match against the chart's xField (typically a date
 * like "2025-04-01" or a label like "Q2"). The renderer compares stringly
 * to keep this format-agnostic — match the value the same way the chart's
 * x-axis presents it.
 *
 * Free for everyone (no tier gate) — annotations are a small UX win
 * available across all plans.
 */
export const ChartAnnotationSchema = z.object({
  xValue: z.string().min(1),
  label: z.string().min(1),
  variant: z.enum(["info", "success", "warning", "danger", "neutral"]).default("info"),
  /**
   * Curated Lucide stroke icon prefixed to the label flag. Set to
   * "auto" to match the variant; "none" to suppress. Optional so legacy
   * annotations using the `icon` string render as before.
   */
  iconKind: VariantIconKind.optional(),
  /** Legacy free-form icon string. Use iconKind for new configs. */
  icon: z.string().optional(),
});
export type ChartAnnotation = z.infer<typeof ChartAnnotationSchema>;

export const ChartConfigSchema = z.object({
  queryId: z.string(),
  chartType: z.enum([
    "bar", "line", "area", "pie", "donut", "combo",
    "treemap", "funnel", "scatter", "radar",
    // Tier 2 chart types — gated behind viz.chart.* (Team plan).
    "gauge",      // Radial progress gauge with target band + zones
    "waterfall",  // Bridge chart for P&L deltas, running totals
    "bullet",     // Compact KPI vs target with qualitative bands
    "sunburst",     // Multi-level composition rings (region -> country -> city)
    "sankey",       // Flow between stages (source -> target, sized by value)
    "streamgraph",  // Wiggle-offset stacked area — proportion over time
  ]).default("bar"),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  xField: z.string(),
  yFields: z.array(z.string()).min(1),
  /**
   * Bar charts only. "horizontal" lays bars left-to-right with the category
   * labels down the side — the readable choice when categories are long
   * text (site names, question labels) that would otherwise be truncated or
   * turned sideways along the x-axis.
   *
   * Named for the direction the BARS run, which is the opposite of what
   * Recharts calls it (`layout="vertical"` produces horizontal bars).
   *
   * Optional rather than `.default("vertical")` deliberately: a defaulted
   * field is REQUIRED on the inferred output type, which would force every
   * hand-written chart block literal in the codebase to name it. Absent
   * means vertical.
   */
  orientation: z.enum(["vertical", "horizontal"]).optional(),
  /** For combo charts: which yFields render as lines (vs default bars). */
  lineFields: z.array(z.string()).optional(),
  /**
   * Scatter / bubble: optional 3rd numeric axis driving point size.
   * Treemap: optional column that drives cell color (ROI, margin, etc).
   */
  sizeField: z.string().optional(),
  colorField: z.string().optional(),
  /**
   * Sunburst only. Ordered outer-to-inner... actually center-to-edge list of
   * grouping columns, e.g. ["region", "country", "city"] — each ring is one
   * level, sized by summing yFields[0] over the rows in that branch. When
   * omitted, Sunburst falls back to a single ring keyed by xField (same
   * degrade-gracefully bar every other chart type clears — see
   * chartCompatibility.ts's eligibility check for "sunburst").
   */
  hierarchyFields: z.array(z.string()).optional(),
  /**
   * Sankey only. Each row is one flow: xField = source node, targetField =
   * destination node, yFields[0] = flow value. Sankey has no eligible
   * fallback without this field (a single categorical column can't describe
   * a flow) — checkChartTypeEligibility rejects it with an explanatory
   * reason until targetField is set.
   */
  targetField: z.string().optional(),
  stacked: z.boolean().optional(),
  showLegend: z.boolean().optional(),
  /** Show value labels at the end of each bar/point. */
  showDataLabels: z.boolean().optional(),
  /**
   * Single-series categorical coloring (bar charts only).
   *
   * When the chart has exactly one yField over categorical x-buckets, color
   * each bar with the next color from the active theme palette (cycling).
   * Without this, every bar in a single-series chart shares palette[0] and
   * the chart reads as monotone — fine for time-series, dull for category
   * comparisons like "Revenue by region" or "Tickets by team."
   *
   * Has no effect on multi-series charts (those already convey category via
   * series color), on stacked charts (segment color comes from the series),
   * or on non-bar chart types.
   */
  categoricalColor: z.boolean().optional(),
  /**
   * Emphasis colouring (bar and pie/donut, single series only).
   *
   * Paints the FIRST N rows in the series colour and everything after them in
   * a recessive grey, so a chart argues a point instead of just listing values:
   * "three sites hold 70% of unbilled value" reads at a glance when the other
   * five recede. Sort the query descending — N counts rows in render order.
   *
   * This is a THIRD colour semantic, deliberately distinct from the two that
   * already exist, and it is opt-in for that reason:
   *   - series colour     — which measure this is
   *   - categoricalColor  — which category this is
   *   - emphasisTop       — whether this row is part of the finding
   * Nothing infers it. An author decides what the chart is arguing; a wrong
   * automatic guess would grey out real data and quietly mislead.
   *
   * Composition, highest priority first: a forecast row keeps the forecast
   * accent (a projected bar is a different KIND of bar), then de-emphasis,
   * then categoricalColor. No effect on multi-series or stacked charts, where
   * colour is already carrying the series.
   */
  emphasisTop: z.number().int().min(1).optional(),
  /** Number format hint for axis ticks + tooltips + data labels. */
  valueFormat: z.enum(["number", "currency", "percent", "compact"]).optional(),
  /** Optional reference lines (target, threshold, etc). */
  referenceLines: z.array(ReferenceLineSchema).optional(),
  /** Optional event markers (campaign launches, holidays, outages…). */
  annotations: z.array(ChartAnnotationSchema).optional(),
  /**
   * Forecast projection — see ForecastConfigSchema. When set on line / area /
   * combo / bar, the renderer computes a linear-regression projection N
   * periods past the last observed point, draws a dashed continuation
   * through the projected mean, and (if showBands is true) shades a 95%
   * confidence band.
   */
  forecast: ForecastConfigSchema.optional(),
  /**
   * Gauge / bullet chart fields (chartType "gauge" or "bullet"). The first
   * yField is treated as the metric value; min/max bound the gauge/bar
   * range, target draws a marker, and zones[] paints qualitative bands
   * (e.g. red/amber/green tiers under the value).
   */
  gaugeMin:    z.number().optional(),
  gaugeMax:    z.number().optional(),
  gaugeTarget: z.number().optional(),
  gaugeZones:  z.array(z.object({
    upTo: z.number(),
    color: z.enum(["danger", "warning", "success", "info", "neutral"]).default("neutral"),
  })).optional(),
  /**
   * Client-side post-processing applied to the dataset before render. Useful
   * when the underlying source can't sort/limit (e.g., REST APIs that just
   * dump all rows). For SQL prefer ORDER BY + LIMIT in the query itself.
   */
  orderBy: z.string().optional(),
  orderDirection: z.enum(["asc", "desc"]).optional(),
  limit: z.number().int().positive().max(500).optional(),
  drilldown: DrillThroughSchema.optional(),
  /**
   * Whole-dashboard drill-down (distinct from `drilldown` above, which opens
   * a side panel of raw rows for THIS block only). Names a report parameter
   * (see `report.parameters`) — clicking a bar/segment sets that parameter
   * to the clicked value and re-runs the ENTIRE report, so every block that
   * references `:{drillParam}` in its SQL re-scopes together (KPIs, other
   * charts, maps — not just this one), exactly like the existing filter bar
   * (`FilterBar.tsx` -> `/api/reports/[id]/run`) already does for manual
   * filter changes. The Dashboard viewer tracks a breadcrumb of drilled
   * values so the reader can jump back to any earlier level. Wired up in
   * the Dashboard viewer only — see ROADMAP-ANALYSIS-APP.md's general,
   * non-geography-specific drill-down.
   */
  drillParam: z.string().optional(),
  /**
   * AI Chart Caption (Tier 4 — ai.chart_caption, Business plan).
   *
   * When true, the renderer asks Claude to summarize the chart's visible
   * data into a one-line analyst note ("Q4 EMEA mobile spend +27% —
   * outperforming the channel average") and renders it under the chart.
   *
   * The caption itself isn't stored on the block — it's generated on
   * demand from the rendered data and the chart's own metadata. We cache
   * server-side keyed by a hash of {title, type, fields, data slice}, so
   * identical renders don't re-burn tokens.
   */
  aiCaption: z.boolean().optional(),
});

export const ImageConfigSchema = z.object({
  src: z.string().url().or(z.string().startsWith("/")),
  alt: z.string().default(""),
  fit: z.enum(["contain", "cover", "fill"]).default("contain"),
});

export const DividerConfigSchema = z.object({
  style: z.enum(["solid", "dashed", "dotted"]).default("solid"),
  thickness: z.number().int().min(1).max(8).default(1),
});

export const CalloutConfigSchema = z.object({
  variant: z.enum(["info", "success", "warning", "danger", "neutral"]).default("info"),
  title: z.string().default(""),
  body: z.string().default(""),
});

export const ProgressConfigSchema = z.object({
  label: z.string().default("Progress"),
  queryId: z.string().optional(),
  valueField: z.string().optional(),
  // Set `labelField` (with `queryId`) to render ONE ROW PER RESULT ROW —
  // a ranked list of tracked things, each with its own bar. Without it the
  // block keeps its original single-bar behaviour reading row 0, which is
  // what every stored definition predating this expects.
  labelField: z.string().optional(),
  // Secondary line under each row's name. List mode only.
  descriptionField: z.string().optional(),
  // Ceiling on rendered rows, so a query that suddenly returns thousands
  // degrades to a long-but-finite list instead of hanging the page.
  // Optional, not defaulted — a defaulted field is required on the inferred
  // output type and would break every existing progress-block literal.
  maxRows: z.number().int().min(1).max(50).optional(),
  value: z.number().min(0).max(100).default(50),
  showPercent: z.boolean().default(true),
  color: z.enum(["primary", "emerald", "amber", "rose", "sky"]).default("primary"),
});

export const PageBreakConfigSchema = z.object({});

/**
 * Map block. Renders a world choropleth (countries colored by aggregated
 * value), a US-states map, or a Thailand provinces map. The country/us-state
 * renderer fetches d3-geo + topology from a CDN at runtime, so no extra npm
 * deps are required; thailand-province instead uses pre-baked SVG path data
 * bundled in lib/reporting/thailandProvincePaths.ts (no runtime fetch at all
 * — see that file's header for provenance).
 *
 *   - regionField: column on the dataset that holds the region key
 *     (ISO-3 alpha-3 country code for "country", 2-letter state code for
 *     "us-state", or the English camelCase province slug — e.g.
 *     "narathiwat", "chiangMai" — for "thailand-province").
 *   - valueField: numeric column to aggregate by region.
 *   - aggregation: how to roll up multiple rows that share a region.
 *
 * Click-to-drill is supported via the same DrillThroughContext as charts —
 * the clicked region's key is sent as the filter value.
 */
export const MapConfigSchema = z.object({
  queryId: z.string(),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  regionType: z.enum(["country", "us-state", "thailand-province"]).default("country"),
  regionField: z.string(),
  valueField: z.string(),
  aggregation: z.enum(["sum", "avg", "count", "min", "max"]).default("sum"),
  format: z.enum(["number", "currency", "percent", "compact"]).default("compact"),
  ramp: z.enum(["primary", "emerald", "amber", "rose", "cyan"]).default("primary"),
  drilldown: DrillThroughSchema.optional(),
  /** See ChartConfigSchema's drillParam doc — same mechanism. */
  drillParam: z.string().optional(),
  /**
   * Optional point-marker overlay (e.g. districts/schools), only rendered
   * when regionType === "thailand-province". A separate query from `queryId`
   * so the pins can be scoped to whatever region is currently drilled into
   * (bind the same drillParam in this query's SQL) — the choropleth query
   * and the pins query stay independent.
   */
  pinsQueryId: z.string().optional(),
  pinNameField: z.string().optional(),
  pinLonField: z.string().optional(),
  pinLatField: z.string().optional(),
  pinValueField: z.string().optional(),
});

/**
 * Heatmap block. Two visual modes:
 *
 *   - calendar: GitHub-style year grid. dateField is the date column,
 *     valueField is the numeric column. Cells are days; intensity scales by
 *     the (summed) value for that day. Great for "campaign starts" or
 *     "deals closed by day" kinds of cadence stories.
 *
 *   - grid: 2D categorical heatmap. xField + yField name the two
 *     dimensions, valueField is the cell value (raw, not aggregated - the
 *     query is expected to have already grouped). Great for things like
 *     "email open rate by hour-of-day x day-of-week".
 *
 * Color ramp scales linearly from background -> primary at value === maxAbs.
 * Negative values flip to a destructive ramp.
 */
export const HeatmapConfigSchema = z.object({
  queryId: z.string(),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  mode: z.enum(["calendar", "grid", "tiles"]).default("calendar"),
  /** Calendar mode. ISO date column (YYYY-MM-DD). */
  dateField: z.string().optional(),
  /** Grid mode. */
  xField: z.string().optional(),
  yField: z.string().optional(),
  /**
   * Tiles mode. One tile per result row, wrapped in a responsive grid —
   * a status board (sites, regions, accounts), not a matrix. Unlike grid
   * mode there are no axes, and a tile can carry three pieces of text.
   */
  labelField: z.string().optional(),
  /** Small monospace code above the label, e.g. a site or account id. */
  codeField: z.string().optional(),
  /**
   * Column holding a `success | warning | danger | info | neutral` value,
   * mapped to the theme's semantic tokens. This is the point of tiles mode:
   * colour by CATEGORY, where grid/calendar can only shade by magnitude.
   * Unrecognised values fall back to neutral. Omit the field and tiles fall
   * back to the same intensity ramp the other modes use.
   */
  statusField: z.string().optional(),
  valueField: z.string(),
  /** Aggregation across rows that share the same cell key. */
  aggregation: z.enum(["sum", "avg", "count", "min", "max"]).default("sum"),
  format: z.enum(["number", "currency", "percent", "compact"]).default("compact"),
  /** Optional fixed color ramp; defaults to primary tint. */
  ramp: z.enum(["primary", "emerald", "amber", "rose", "cyan"]).default("primary"),
  /**
   * Tiles mode drill-through (D1) — same contract DashboardViewer's own
   * blocks already use (block.config.drillParam names a report/app
   * parameter). Clicking a tile whose codeField value matches sets that
   * parameter instead of only being a static display. Undefined = no
   * drill configured, tiles stay display-only (today's behaviour).
   */
  drillParam: z.string().optional(),
});

/**
 * Cross-tab / pivot table block. Aggregates a flat dataset by two dimensions
 * (rowField × colField) and an aggregation function over valueField. The
 * renderer does the grouping client-side so the same query can power a chart,
 * a list, and a pivot - and so the existing filter bar narrows everything in
 * lockstep without any extra runner work.
 */
export const PivotConfigSchema = z.object({
  queryId: z.string(),
  title: z.string().optional(),
  rowField: z.string(),
  colField: z.string(),
  valueField: z.string(),
  aggregation: z.enum(["sum", "avg", "count", "min", "max"]).default("sum"),
  format: z.enum(["number", "currency", "percent"]).default("number"),
  showRowTotals: z.boolean().default(true),
  showColTotals: z.boolean().default(true),
  heatmap: z.boolean().default(true),
});

// Round 11 — cohort + funnel block configs. Defined here (before
// BlockConfigSchemas) so the keyof-derived BlockType picks them up.
// The renderers in components/blocks/CohortRetentionBlock.tsx +
// FunnelBlock.tsx consume the rows from `lib/cohort/sql.ts`.

export const CohortRetentionConfigSchema = z.object({
  queryId: z.string(),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  cohortField: z.string().default("cohort_period"),
  periodField: z.string().default("periods_since_signup"),
  retentionField: z.string().default("retention_pct"),
  cohortSizeField: z.string().optional(),
  cellFormat: z.enum(["percent", "count"]).default("percent"),
});

export const FunnelConfigSchema = z.object({
  queryId: z.string(),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  stepField: z.string().default("step_name"),
  reachedField: z.string().default("users_reached"),
  conversionFromPriorField: z.string().optional(),
  conversionFromTopField: z.string().optional(),
});

export const BlockConfigSchemas = {
  title: TitleConfigSchema,
  text: TextConfigSchema,
  table: TableConfigSchema,
  kpi: KpiConfigSchema,
  chart: ChartConfigSchema,
  image: ImageConfigSchema,
  divider: DividerConfigSchema,
  pageBreak: PageBreakConfigSchema,
  callout: CalloutConfigSchema,
  progress: ProgressConfigSchema,
  pivot: PivotConfigSchema,
  heatmap: HeatmapConfigSchema,
  map: MapConfigSchema,
  cohort_retention: CohortRetentionConfigSchema,
  funnel: FunnelConfigSchema,
} as const;

export type BlockType = keyof typeof BlockConfigSchemas;

// ---------- Block union ----------

const BaseBlock = z.object({
  id: z.string(),
  x: z.number().int().min(0).max(12),
  y: z.number().int().min(0),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(100),
  /** RBAC (Adapts-to-reader). Empty/undefined = visible to everyone. */
  visibleToRoles: z.array(z.string()).optional(),
  /**
   * Content localization. Keyed by locale code (matches `Locale` in
   * lib/i18n/dict.ts, e.g. "en"/"th"/"zh"), each entry is a flat map of
   * this block's own config field names to translated text (e.g. a title
   * block: `{ text: "...", subtitle: "..." }`; a kpi block: `{ label: "..." }`).
   * Unset fields, and the base language itself, fall back to `config` as
   * written — this only ever *overrides*, never replaces the source of
   * truth. See lib/reporting/localize.ts for the resolver.
   */
  i18n: z.record(z.record(z.string())).optional(),
});

export const BlockSchema = z.discriminatedUnion("type", [
  BaseBlock.extend({ type: z.literal("title"), config: TitleConfigSchema }),
  BaseBlock.extend({ type: z.literal("text"), config: TextConfigSchema }),
  BaseBlock.extend({ type: z.literal("table"), config: TableConfigSchema }),
  BaseBlock.extend({ type: z.literal("kpi"), config: KpiConfigSchema }),
  BaseBlock.extend({ type: z.literal("chart"), config: ChartConfigSchema }),
  BaseBlock.extend({ type: z.literal("image"), config: ImageConfigSchema }),
  BaseBlock.extend({ type: z.literal("divider"), config: DividerConfigSchema }),
  BaseBlock.extend({ type: z.literal("pageBreak"), config: PageBreakConfigSchema }),
  BaseBlock.extend({ type: z.literal("callout"), config: CalloutConfigSchema }),
  BaseBlock.extend({ type: z.literal("progress"), config: ProgressConfigSchema }),
  BaseBlock.extend({ type: z.literal("pivot"), config: PivotConfigSchema }),
  BaseBlock.extend({ type: z.literal("heatmap"), config: HeatmapConfigSchema }),
  BaseBlock.extend({ type: z.literal("map"), config: MapConfigSchema }),
  BaseBlock.extend({ type: z.literal("cohort_retention"), config: CohortRetentionConfigSchema }),
  BaseBlock.extend({ type: z.literal("funnel"), config: FunnelConfigSchema }),
]);
export type Block = z.infer<typeof BlockSchema>;

// ---------- Page and Report ----------

export const PageSchema = z.object({
  id: z.string(),
  size: z.enum(["A4", "Letter", "Legal"]).default("A4"),
  orientation: z.enum(["portrait", "landscape"]).default("portrait"),
  blocks: z.array(BlockSchema),
});
export type Page = z.infer<typeof PageSchema>;

/**
 * Theme presets (Tier 1.7 — viz.theme_presets, Team plan).
 *
 * A theme is just a (palette, typography) tuple applied report-wide. The
 * palette swaps the chart series colors; typography swaps the font stack
 * for headings inside ReportDocument. Themes are deliberately limited —
 * we want reports to look *good* by default, not infinitely tweakable.
 *
 * Adding a new theme = entry in THEME_PRESETS in lib/reporting/themes.ts +
 * the slug here. The renderer picks up the new entry automatically.
 */
export const ThemeSchema = z.enum([
  "default",   // Indigo + Instrument Sans — the default Curf look
  "sunset",    // Warm rose / amber / fuchsia — marketing & creative
  "forest",    // Emerald / teal / lime — sustainability, ESG, ops
  "midnight",  // Cool slate / cyan / violet — finance, governance
  "candy",     // High-contrast pop — consumer dashboards
  "boardroom", // Navy / signal blue / graphite — the consulting-exhibit palette
]);
export type Theme = z.infer<typeof ThemeSchema>;

/**
 * Chart style presets — the *form* axis, deliberately separate from ThemeSchema
 * above (which is the *colour* axis). A theme decides what a chart is coloured
 * with; a style decides what it's shaped like. Keeping them apart means a
 * tenant's custom palette composes with either look instead of forcing a
 * preset per (palette x form) combination.
 *
 * Adding a style = entry in CHART_STYLE_PRESETS in lib/reporting/chartStyles.ts
 * + the slug here. Renderers read the resolved token object, never the slug.
 */
export const ChartStyleSchema = z.enum([
  "classic",     // Today's look — flat fills, tight corners, value axis. The default.
  "modern",      // Gradient fills, soft corners, ghost tracks, direct labels
  "enterprise",  // Flat, square, gridless, numbers on the marks — consulting exhibit
]);
export type ChartStyle = z.infer<typeof ChartStyleSchema>;

export const ReportSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  /**
   * Optional report-level theme. When unset, renderers fall back to the
   * "default" theme. The save endpoint enforces the viz.theme_presets gate
   * — non-Team tenants can read themed reports but can't change away from
   * default.
   */
  theme: ThemeSchema.optional(),
  /**
   * Optional report-level chart style. When unset, renderers fall back to the
   * tenant default and then "classic" — so a report saved before this field
   * existed keeps rendering exactly as it did.
   */
  chartStyle: ChartStyleSchema.optional(),
  /**
   * Optional report-level currency override (ISO 4217, e.g. "THB"). When
   * unset, renderers fall back to the tenant's default currency, then
   * "USD". See lib/reporting/currency.ts.
   */
  currency: z.string().length(3).optional(),
  /** Content localization for the report's own name/description — same
   *  locale-code keying as a block's `i18n` (see BaseBlock above). */
  nameI18n: z.record(z.string()).optional(),
  descriptionI18n: z.record(z.string()).optional(),
  parameters: z.array(ParameterSchema).default([]),
  dataSources: z.array(DataSourceDefSchema).default([]),
  pages: z.array(PageSchema).min(1),
});
export type Report = z.infer<typeof ReportSchema>;

// ---------- Helpers ----------

export function emptyReport(name = "Untitled Report"): Report {
  return {
    version: 1,
    name,
    parameters: [],
    dataSources: [],
    pages: [
      {
        id: crypto.randomUUID(),
        size: "A4",
        orientation: "portrait",
        blocks: [],
      },
    ],
  };
}

export function parseReport(raw: unknown): Report {
  return ReportSchema.parse(raw);
}
