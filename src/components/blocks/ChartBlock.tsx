"use client";
import { useEffect, useMemo, useState } from "react";
import { Sparkles, BarChart3 as LucideBarChart, LineChart as LucideLineChart, PieChart as LucidePieChart, Activity as LucideAreaChart, TrendingUp as LucideTrendingUp, Activity as LucideActivity, HelpCircle, ChevronDown as LucideChevronDown } from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { profileColumns, type ChartTypeValue } from "@/lib/reporting/chartCompatibility";
import { CHART_TYPE_ICON, groupChartTypes } from "@/components/blocks/chartTypeOptions";
import { cn } from "@/lib/utils";
import {
  CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
  ReferenceLine,
} from "recharts";
import type { BlockRenderContext } from "./types";
import { ProvenanceBadge } from "./ProvenanceBadge";
import { ShowWorkButton } from "./ShowWorkButton";
import { AskButton } from "./AskButton";
import { CommentButton } from "./CommentButton";
import { useDrillThrough } from "@/components/providers/drill-through-context";
import { useTheme, useChartStyle } from "@/components/providers/ThemeProvider";
import { useCurrency } from "@/components/providers/CurrencyProvider";
import { useWhy } from "@/components/blocks/WhyDrawer";
import { useT } from "@/lib/i18n/LocaleContext";
import { BlockActions } from "./BlockActions";
import { ChartPinOverlay } from "./ChartPinOverlay";
import { EmbedButton } from "./EmbedButton";
import { projectSeries, projectSeriesETS, detectCadenceUnit, THAI_MONTHS_ABBR, type CadenceUnit } from "@/lib/reporting/forecast";
import { computeForecastBoundary, computeForecastRangeSummary, predictionDecorElements } from "./charts/PredictionOverlay";
import { formatValue } from "./charts/shared";
import { buildSnapshotCandidates } from "@/lib/reporting/forecastSnapshot";
import { BlockEmptyState } from "./BlockEmptyState";
import { renderScatterChart, renderFunnelChart } from "./charts/scatterFunnelRenderers";
import { renderTreemapChart, renderWaterfallChart } from "./charts/treemapWaterfallRenderers";
import { renderGaugeChart, renderBulletChart } from "./charts/gaugeBulletRenderers";
import { renderPieChart } from "./charts/pieRenderer";
import { renderBarChart } from "./charts/barRenderer";
import { renderLineChart, renderAreaChart, renderComboChart } from "./charts/lineAreaComboRenderers";
import { renderRadarChart } from "./charts/radarRenderer";
import { renderStreamgraphChart } from "./charts/streamgraphRenderer";
import { renderSunburstChart } from "./charts/sunburstRenderer";
import { renderSankeyChart } from "./charts/sankeyRenderer";

// formatValue / AXIS_PROPS / TOOLTIP_STYLE / DEFAULT_PALETTE and the chart
// ink tokens live in ./charts/shared.ts, used only by the per-chart-type
// renderers.

// TreemapCell now lives in ./charts/treemapWaterfallRenderers.tsx alongside
// renderTreemapChart(); DEFAULT_PALETTE moved to ./charts/shared.ts.

// ---- Tier 2 chart helpers live in charts/Gauge.tsx (gauge, bullet, waterfall) ----

/**
 * Forecast x-label generator. Tries to extend the last historical label
 * along common temporal patterns (quarter / month / year / ISO date). Falls
 * back to "+1", "+2" so the projection always renders even if the format
 * is unfamiliar. We DON'T parse via Date globally — too many false positives
 * for short categorical labels like "Q4" or "Jan".
 *
 * `stepDays` (ISO-date branch only) is the REAL gap between this series'
 * last two points — see detectCadenceUnit in lib/reporting/forecast.ts —
 * not a blind "weekly" guess, so a monthly-snapshot chart projects onto
 * realistic future dates instead of ones 7 days apart.
 */
function smartXLabel(lastValue: unknown, k: number, stepDays: number = 7): string {
  if (typeof lastValue !== "string") return `+${k}`;
  // Quarter: "2025-Q3" → +1 = "2025-Q4", +2 = "2026-Q1"
  const qMatch = lastValue.match(/^(\d{4})-Q([1-4])$/);
  if (qMatch) {
    const yr = parseInt(qMatch[1], 10);
    const q = parseInt(qMatch[2], 10);
    const total = q + k;
    const newY = yr + Math.floor((total - 1) / 4);
    const newQ = ((total - 1) % 4) + 1;
    return `${newY}-Q${newQ}`;
  }
  // Year-month: "2025-04" → "2025-05" → "2026-01"
  const ymMatch = lastValue.match(/^(\d{4})-(\d{2})$/);
  if (ymMatch) {
    const yr = parseInt(ymMatch[1], 10);
    const m = parseInt(ymMatch[2], 10);
    const total = m + k;
    const newY = yr + Math.floor((total - 1) / 12);
    const newM = ((total - 1) % 12) + 1;
    return `${newY}-${String(newM).padStart(2, "0")}`;
  }
  // Year only
  const yMatch = lastValue.match(/^(\d{4})$/);
  if (yMatch) {
    return String(parseInt(yMatch[1], 10) + k);
  }
  // ISO date YYYY-MM-DD — advance by the series' own real cadence.
  const dMatch = lastValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dMatch) {
    const d = new Date(lastValue);
    if (!isNaN(d.getTime())) {
      d.setUTCDate(d.getUTCDate() + stepDays * k);
      return d.toISOString().slice(0, 10);
    }
  }
  // Thai abbreviated month + 2-digit Buddhist year: "ต.ค. 68" → "พ.ย. 68" —
  // common in Thai government/budget report SQL (month_label columns).
  const thMatch = lastValue.match(new RegExp(`^(${THAI_MONTHS_ABBR.join("|").replace(/\./g, "\\.")})\\s(\\d{2})$`));
  if (thMatch) {
    const mIdx = THAI_MONTHS_ABBR.indexOf(thMatch[1]);
    const yy = parseInt(thMatch[2], 10);
    const total = yy * 12 + mIdx + k;
    const newYy = Math.floor(total / 12) % 100;
    const newM = ((total % 12) + 12) % 12;
    return `${THAI_MONTHS_ABBR[newM]} ${String(newYy).padStart(2, "0")}`;
  }
  return `+${k}`;
}

export function ChartBlock(props: BlockRenderContext) {
  if (props.block.type !== "chart") return null;
  return <ChartBlockInner {...props} block={props.block} />;
}

type ChartInnerProps = Omit<BlockRenderContext, "block"> & { block: Extract<BlockRenderContext["block"], { type: "chart" }> };

/**
 * Chart-type picker — non-persisted "view as" toggle (see overrideChartType
 * in ChartBlockInner). Lists all 12 supported chart types grouped by
 * business purpose; a type that would render empty/broken for this block's
 * actual xField/yFields is disabled with a tooltip explaining why, instead
 * of being silently pickable and then showing nothing.
 */
function ChartTypeSelector({
  current, onChange, xField, yFields, sizeField, rows,
}: {
  current: string;
  onChange: (t: string) => void;
  xField: string;
  yFields: string[];
  sizeField?: string;
  rows: Array<Record<string, unknown>>;
}) {
  const groups = useMemo(() => {
    const profiles = profileColumns(rows);
    return groupChartTypes({ xField, yFields, sizeField }, profiles);
  }, [rows, xField, yFields, sizeField]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="no-print inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
          title="Change Chart Type"
        >
          <LucideBarChart className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {groups.map((group, gi) => (
          <div key={group.purpose}>
            {gi > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-[10px]">{group.label}</DropdownMenuLabel>
            {group.items.map((item) => {
              const Icon = CHART_TYPE_ICON[item.value as ChartTypeValue];
              return (
                <DropdownMenuItem
                  key={item.value}
                  disabled={!item.eligible}
                  onClick={() => item.eligible && onChange(item.value)}
                  className={current === item.value ? "bg-muted" : ""}
                >
                  {/* pointer-events:auto re-enables hover on a disabled item
                      (the wrapper gets pointer-events:none), so the native
                      title tooltip can still explain why it's greyed out. */}
                  <span
                    className="flex w-full items-center"
                    style={{ pointerEvents: "auto" }}
                    title={item.eligible ? undefined : item.reason}
                  >
                    <Icon className="mr-2 h-4 w-4 shrink-0" />
                    {item.labelEn}
                  </span>
                </DropdownMenuItem>
              );
            })}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type ForecastMethod = "linear" | "ets" | "llm";
type ViewerForecastPref = { enabled: boolean; method: ForecastMethod; periods: number } | null;

const FORECAST_METHOD_OPTIONS: { slug: ForecastMethod; Icon: typeof LucideActivity }[] = [
  { slug: "linear", Icon: LucideActivity },
  { slug: "ets", Icon: LucideTrendingUp },
  { slug: "llm", Icon: Sparkles },
];

/**
 * Viewer-local forecast control — lets someone WITHOUT edit access turn a
 * forecast overlay on/off and pick method/horizon for themselves, on any
 * chart that supports one, regardless of whether the report author saved a
 * forecast config. `value` is the viewer's own preference (persisted server
 * side via /api/user/preferences — see ChartBlockInner's effect below);
 * `null` means "no override yet, use whatever the report itself has".
 * `reportDefault` seeds the picker with the author's own forecast config
 * (if any) so toggling on for the first time doesn't reset to unrelated
 * defaults.
 */
function ForecastControl({
  value, onChange, reportDefault, unit, accuracy,
}: {
  value: ViewerForecastPref;
  onChange: (next: NonNullable<ViewerForecastPref>) => void;
  reportDefault: { method: ForecastMethod; periods: number } | undefined;
  /** "day"/"week"/"month"/… — see detectCadenceUnit. "point" when the x-axis
   *  labels aren't a recognizable time pattern, so we fall back to a plain
   *  "points" wording rather than guessing a unit that might be wrong. */
  unit: CadenceUnit;
  /** This block's own forecast track record (Business tier — Forecast
   *  Accuracy / Trust Layer). Undefined/null when there's no history yet
   *  or the tenant isn't gated in — the badge just doesn't render then,
   *  rather than showing a misleading "0%". */
  accuracy?: { hitRatePct: number; total: number } | null;
}) {
  const { t } = useT();
  const [showMethodology, setShowMethodology] = useState(false);
  const enabled = value?.enabled ?? !!reportDefault;
  const method = value?.method ?? reportDefault?.method ?? "linear";
  const periods = value?.periods ?? reportDefault?.periods ?? 4;
  const unitWord = unit === "point"
    ? t(`forecast.unit.point.${periods === 1 ? "singular" : "plural"}`)
    : t(`forecast.unit.${unit}.${periods === 1 ? "singular" : "plural"}`);

  function patch(p: Partial<{ enabled: boolean; method: ForecastMethod; periods: number }>) {
    onChange({ enabled, method, periods, ...p });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            "no-print inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-foreground",
            enabled ? "text-primary" : "text-muted-foreground/60",
          )}
          title={t("forecast.triggerTitle")}
        >
          <LucideTrendingUp className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 space-y-3 p-3.5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">{t("forecast.title")}</p>
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
              {t("forecast.description")}
            </p>
          </div>
          {/* Switch-styled checkbox — bigger, clearer affordance than a bare checkbox for a toggle this consequential. */}
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={() => patch({ enabled: !enabled })}
            className={cn(
              "relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors",
              enabled ? "bg-primary" : "bg-muted-foreground/30",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 h-4 w-4 rounded-full bg-card shadow transition-transform",
                enabled ? "translate-x-4" : "translate-x-0.5",
              )}
            />
          </button>
        </div>
        {enabled && (
          <>
            <div className="space-y-1.5 border-t border-border pt-3">
              <p className="text-[11px] font-medium text-muted-foreground">{t("forecast.howToPredict")}</p>
              {FORECAST_METHOD_OPTIONS.map((opt) => {
                const active = method === opt.slug;
                return (
                  <button
                    key={opt.slug}
                    type="button"
                    onClick={() => patch({ method: opt.slug })}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-md border p-2 text-left transition-colors",
                      active ? "border-primary bg-primary/5" : "border-border hover:bg-muted",
                    )}
                  >
                    <opt.Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", active ? "text-primary" : "text-muted-foreground")} />
                    <span>
                      <span className="block text-xs font-medium">{t(`forecast.method.${opt.slug}.label`)}</span>
                      <span className="block text-[10.5px] leading-snug text-muted-foreground">{t(`forecast.method.${opt.slug}.hint`)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
              <div>
                <p className="text-xs font-medium">{t("forecast.howFarAhead")}</p>
                <p className="text-[10.5px] text-muted-foreground">
                  {unit === "point"
                    ? t("forecast.periodsHintPoint")
                    : t("forecast.periodsHint").replace("{periods}", String(periods)).replace("{unit}", unitWord)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <input
                  type="number"
                  min={1}
                  max={24}
                  value={periods}
                  onChange={(e) => patch({ periods: Math.max(1, Math.min(24, Number(e.target.value) || 1)) })}
                  className="h-7 w-14 rounded border border-border bg-background px-1.5 text-center text-xs"
                />
                {unit !== "point" && (
                  <span className="text-[11px] text-muted-foreground">{unitWord}</span>
                )}
              </div>
            </div>
            <div className="border-t border-border pt-2.5">
              <button
                type="button"
                onClick={() => setShowMethodology((s) => !s)}
                className="flex w-full items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <HelpCircle className="h-3 w-3 shrink-0" />
                {t("forecast.methodologyToggle")}
                <LucideChevronDown className={cn("ml-auto h-3 w-3 shrink-0 transition-transform", showMethodology && "rotate-180")} />
              </button>
              {showMethodology && (
                <div className="mt-1.5 space-y-1.5">
                  <p className="text-[10.5px] leading-relaxed text-muted-foreground">
                    {t(`forecast.methodology.${method}`)}
                  </p>
                  <p className="text-[10.5px] leading-relaxed text-muted-foreground/80">
                    {t("forecast.methodology.why196")}
                  </p>
                </div>
              )}
            </div>
            {accuracy && accuracy.total > 0 && (
              <div className="rounded-md border border-primary/20 bg-primary/5 px-2.5 py-2 text-[11px] text-foreground">
                {t("forecast.accuracyBadge")
                  .replace("{pct}", String(accuracy.hitRatePct))
                  .replace("{n}", String(accuracy.total))}
              </div>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChartBlockInner({ block, dataset, provenance, print, report, params, reportDbId, bare }: ChartInnerProps) {
  const cfg = block.config;
  const [overrideChartType, setOverrideChartType] = useState<string | null>(null);

  const {
    queryId, chartType: initialChartType, title, subtitle, xField, yFields, lineFields,
    stacked, showLegend, showDataLabels, valueFormat, referenceLines, drilldown, drillParam,
    orderBy, orderDirection, limit, aiCaption,
  } = cfg;
  
  const chartType = overrideChartType ?? initialChartType;
  // Optional fields added in later schema revisions — destructured separately
  // so the strongly-typed core (yFields[], etc) keeps its narrow types.
  const annotations = (cfg as any).annotations as Array<{ xValue: string; label: string; icon?: string; variant: "info"|"success"|"warning"|"danger"|"neutral" }> | undefined;
  const reportForecast = (cfg as any).forecast as { method: ForecastMethod; periods: number; showBands: boolean } | undefined;
  // categoricalColor (cfg.categoricalColor) now read inside renderBarChart().

  // Excluded chart types mirror the forecast-eligibility comment further
  // down (waterfall/scatter/pie/etc have no time axis to project along).
  const forecastEligible = chartType === "line" || chartType === "area" || chartType === "combo" || chartType === "bar";

  // Viewer-local forecast override (ForecastControl below) — lets a reader
  // without edit access turn a forecast on/off and pick method/horizon for
  // themselves, independent of what the report author saved. Persisted per
  // user via /api/user/preferences so it sticks across every report they
  // view, not just this session. `null` = no override recorded yet, defer
  // to the report's own saved config.
  const [viewerForecastPref, setViewerForecastPref] = useState<ViewerForecastPref>(null);
  useEffect(() => {
    if (print || !forecastEligible) return;
    let cancelled = false;
    fetch("/api/user/preferences", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const pref = j?.preferences?.forecastViewerPrefs;
        if (!cancelled && pref) setViewerForecastPref(pref);
      })
      .catch(() => { /* no override — falls back to the report's own config */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [print, forecastEligible]);

  function handleForecastChange(next: NonNullable<ViewerForecastPref>) {
    setViewerForecastPref(next);
    fetch("/api/user/preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ forecastViewerPrefs: next }),
    }).catch(() => { /* local state already updated; persistence is best-effort */ });
  }

  // Memoized on the underlying primitives, not just recomputed inline —
  // an object literal here would get a fresh reference every render, and
  // since it feeds the snapshot-recording/accuracy-fetch effects' deps
  // below, an unstable reference re-fires those effects on every render
  // (setAccuracy(null) at the top of the accuracy effect then changes
  // state, which triggers another render, which sees a "new" forecast
  // object again — an infinite loop that floods forecast-snapshot with
  // requests and never lets the accuracy badge settle long enough to paint).
  const viewerEnabled = viewerForecastPref?.enabled;
  const viewerMethod = viewerForecastPref?.method;
  const viewerPeriods = viewerForecastPref?.periods;
  const showBands = reportForecast?.showBands ?? true;
  const forecast = useMemo(() => {
    if (!forecastEligible) return undefined;
    if (viewerForecastPref) {
      return viewerEnabled ? { method: viewerMethod!, periods: viewerPeriods!, showBands } : undefined;
    }
    return reportForecast;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forecastEligible, viewerForecastPref, viewerEnabled, viewerMethod, viewerPeriods, showBands, reportForecast]);
  // Whether the active `forecast` came from the viewer's own global toggle
  // (applies indiscriminately to every chart they view, per ForecastControl's
  // docstring) or from THIS chart's own author-saved config. Matters for the
  // cadence gate below: an author who explicitly turned on forecast for
  // their chart has already judged it's a real time series — trust that
  // even when detectCadenceUnit can't parse the label format (e.g. "ต.ค. 68"
  // Thai month abbreviations aren't ISO dates). The viewer's global toggle
  // carries no such per-chart judgment, so it's the one that needs the gate.
  const forecastIsViewerOverride = !!viewerForecastPref && !!viewerEnabled;

  // Pull the active theme. Categorical series use theme.palette; semantic
  // colors (annotation variants, reference-line variants, threshold rules)
  // continue to use theme-invariant tokens since meaning shouldn't shift.
  const theme = useTheme();
  const chartStyle = useChartStyle();
  const currency = useCurrency();
  const { t } = useT();
  const palette = theme.palette;

  // Stable reference to the raw dataset entry — `?? []` lives INSIDE the
  // useMemo callback below so the logical-expression fallback can't
  // produce a fresh array identity on every render.
  const datasetEntry = dataset[queryId];

  // Extracted from the deps array below — ESLint flags inline subscripts
  // / member-access expressions as "complex expression in deps" and the
  // linter can't see through them to confirm exhaustiveness.
  const firstYField = yFields[0];

  // Client-side post-processing. For SQL queries, ORDER BY + LIMIT in the
  // query itself is preferred. For REST sources that dump all rows (typical
  // for /v3.1/all-style endpoints), this lets the chart slice down to the
  // top N before rendering so we don't draw 250 bars on a 600px canvas.
  const baseRows = useMemo(() => {
    let out = (datasetEntry ?? []) as any[];
    if (orderBy) {
      const dir = (orderDirection ?? "desc") === "asc" ? 1 : -1;
      out = [...out].sort((a, b) => {
        const av = a?.[orderBy];
        const bv = b?.[orderBy];
        const an = typeof av === "number" ? av : Number(av);
        const bn = typeof bv === "number" ? bv : Number(bv);
        if (Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * dir;
        return String(av).localeCompare(String(bv)) * dir;
      });
    }
    if (limit && out.length > limit) out = out.slice(0, limit);
    return out;
  }, [datasetEntry, orderBy, orderDirection, limit]);

  // What one forecast "period" actually represents (day/week/month/…),
  // inferred from the real gap between this series' own last two points —
  // see detectCadenceUnit's docstring. Drives both realistic projected
  // x-labels (stepDays) and the "How far ahead" unit shown in
  // ForecastControl, instead of a generic, unlabeled "4". Computed whenever
  // the chart TYPE supports forecasting at all (not gated on forecast
  // being currently enabled), so the control shows the right unit the very
  // first time a viewer opens it, before they've turned anything on.
  const forecastCadence = useMemo(
    () => (forecastEligible ? detectCadenceUnit(baseRows, xField) : { unit: "point" as CadenceUnit }),
    [forecastEligible, baseRows, xField],
  );

  // Excluded: waterfall (data is re-derived via buildWaterfall, a "Total"
  // row isn't a time step to project past), scatter (x is a numeric axis,
  // not a time-ordered category), and pie/donut/treemap/funnel/gauge/bullet
  // (no time axis to project along).
  //
  // Also excluded: a "point" cadence WHEN the forecast is coming from the
  // viewer's global toggle (see forecastIsViewerOverride above) — that
  // toggle applies indiscriminately to every chart a viewer looks at, with
  // no per-chart judgment behind it, so if detectCadenceUnit can't match
  // the x-axis against any quarter/month/year/date pattern at all, treat it
  // as "not actually a sequence" (e.g. a ranked list of project names)
  // rather than silently painting "+1, +2, +3…" placeholder bars onto an
  // unrelated categorical chart. A report AUTHOR's own saved forecast
  // config is a deliberate per-chart decision, not a blanket override — it
  // stays trusted even when the x-axis is formatted in a way the cadence
  // detector doesn't recognize (e.g. localized month labels like "ต.ค. 68"
  // instead of ISO "2025-10").
  const canForecast = !!forecast
    && (!forecastIsViewerOverride || forecastCadence.unit !== "point")
    && (chartType === "line" || chartType === "area" || chartType === "combo" || chartType === "bar");

  // Whether the ForecastControl toggle is even worth showing: a report
  // author's own saved config already works regardless of cadence (see
  // canForecast above), so the control stays visible to let a viewer tweak
  // method/horizon. But if there's no author config, turning the control on
  // routes through the viewer's GLOBAL preference — which only does
  // anything for THIS chart when detectCadenceUnit recognizes a real time
  // axis. Showing the icon on a chart where clicking it can never produce a
  // forecast (a ranked list of project names, say) reads as a broken
  // control — a customer clicks it expecting a line and gets nothing.
  const forecastControlUseful = forecastEligible && (!!reportForecast || forecastCadence.unit !== "point");

  // Instant, always-available projection — appended for line/area/combo/bar
  // charts. The projection uses the FIRST yField as the basis (multi-series
  // forecast is more complex and rare in practice; ship the common case
  // first). Each forecast row carries `__forecast: true` so renderers can
  // style them differently (dashed continuation, shaded band).
  const linearProjected = useMemo(() => {
    if (!canForecast) return [];
    return projectSeries(baseRows, firstYField, forecast!.periods, {
      xField,
      // Default labeler — "+1", "+2", … unless we can pattern-match the
      // last label as a quarter (2025-Q3 → 2025-Q4) or month (2025-04 →
      // 2025-05). Worth doing because charts mostly use these formats;
      // fallback keeps the projection visible regardless.
      xLabeler: (lastValue, k) => smartXLabel(lastValue, k, forecastCadence.stepDays),
    });
  }, [canForecast, baseRows, forecast, xField, firstYField, forecastCadence.stepDays]);

  // Exponential smoothing — same instant, deterministic profile as the OLS
  // path above (no network round trip), just a different fit. See
  // exponentialSmoothingFit in lib/reporting/forecast.ts for why a user
  // would pick this over "linear".
  const etsProjected = useMemo(() => {
    if (!canForecast || forecast?.method !== "ets") return [];
    return projectSeriesETS(baseRows, firstYField, forecast!.periods, {
      xField,
      xLabeler: (lastValue, k) => smartXLabel(lastValue, k, forecastCadence.stepDays),
    });
  }, [canForecast, forecast?.method, baseRows, forecast, xField, firstYField, forecastCadence.stepDays]);

  // Business-tier upgrade: when forecast.method is "llm", ask the server
  // for a pattern-aware projection (see lib/reporting/llmForecast.ts) and
  // splice its numbers into the SAME point shape the linear fit already
  // produces (same x labels, a band re-centered on the new value) — so the
  // chart starts on the instant linear projection and silently upgrades in
  // place once the model responds, rather than blocking the first paint on
  // a network round trip. Any failure server-side just echoes the linear
  // values back, so this effect converges to a no-op visual change.
  const [llmValues, setLlmValues] = useState<number[] | null>(null);
  useEffect(() => {
    setLlmValues(null);
    if (!canForecast || forecast?.method !== "llm") return;
    const history = baseRows.map((r) => Number(r?.[firstYField])).filter((n) => Number.isFinite(n));
    if (history.length < 2) return;
    let cancelled = false;
    fetch("/api/reports/forecast-llm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ history, periods: forecast!.periods }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && Array.isArray(j?.values) && j.values.length === forecast!.periods) {
          setLlmValues(j.values);
        }
      })
      .catch(() => { /* stays on the linear projection already shown */ });
    return () => { cancelled = true; };
  }, [canForecast, forecast?.method, forecast?.periods, baseRows, firstYField]);

  const projected = useMemo(() => {
    if (!canForecast) return [];
    if (forecast?.method === "ets") return etsProjected;
    if (forecast?.method !== "llm" || !llmValues) return linearProjected;
    return linearProjected.map((p, i) => {
      const linearVal = Number(p[firstYField]);
      const band = Number.isFinite(linearVal) ? Math.abs(Number(p.__upper) - linearVal) : 0;
      const v = llmValues[i];
      if (v === undefined) return p;
      return { ...p, [firstYField]: v, __upper: v + band, __lower: v - band };
    });
  }, [canForecast, forecast?.method, llmValues, linearProjected, etsProjected, firstYField]);

  const data = useMemo(() => {
    if (projected.length === 0) return baseRows;
    return [...baseRows, ...projected];
  }, [baseRows, projected]);
  const proof = !print && provenance ? provenance[queryId] : undefined;
  const ds = !print ? report.dataSources.find((d) => d.id === queryId) ?? null : null;

  // Drill-through wiring. Two independent modes share one onDrill(blockId,
  // value) call: `drilldown` (raw rows, side panel — Report viewer) and
  // `drillParam` (sets a report parameter + re-runs the WHOLE report —
  // Dashboard viewer only, see DrillBreadcrumbBar). Which one actually
  // fires is decided by whichever handler the surface's DrillThroughContext
  // provides; this block only needs to know "is *some* drill configured."
  const onDrill = useDrillThrough();
  const drillEnabled = !print && (!!drilldown || !!drillParam) && !!onDrill;

  // "Why?" everywhere wiring. Any chart click that doesn't have an explicit
  // drill-through configured opens the Why drawer for the clicked x-value
  // and the FIRST y-field. Drill-through wins when configured because the
  // author has explicitly opted into a deeper navigation.
  const openWhy = useWhy();
  const whyEnabled = !print && !drillEnabled && !!openWhy && !!reportDbId;

  function handleClick(payload: any) {
    const value = payload?.activePayload?.[0]?.payload?.[xField] ?? payload?.payload?.[xField];
    if (value === undefined) return;
    if (drillEnabled) {
      onDrill!(block.id, value);
      return;
    }
    if (whyEnabled) {
      openWhy!({
        reportId: reportDbId!,
        blockId: block.id,
        anchor: { field: xField, value: String(value) },
        metric: yFields[0],
        label: title ? `${title} · ${value}` : String(value),
      });
    }
  }

  const gid = block.id.replace(/[^a-zA-Z0-9]/g, "");
  const cursorClass = (drillEnabled || whyEnabled) ? "cursor-pointer" : "";

  // AI Chart Caption (Tier 4 — ai.chart_caption / Business). When the
  // designer flipped this on, fetch a one-line summary and render it under
  // the chart. The endpoint enforces the tier gate; on Free/Team it 402s
  // and we just hide the caption strip — no error UI in the chart itself.
  // Skip in print mode (the caption is interactive, not a static label).
  const [caption, setCaption] = useState<{ text: string; source: "ai" | "rule" } | null>(null);
  // Stable stringified keys so the effect re-runs only when the visible
  // content actually changes — not on every parent re-render that produces
  // a fresh array identity for `data` / `yFields`. Extracted out of the
  // deps array to satisfy the no-complex-expression-in-deps rule.
  const yFieldsKey = JSON.stringify(yFields);
  const dataKey = JSON.stringify(data);
  useEffect(() => {
    if (!aiCaption || print) return;
    if (!data || data.length === 0) return;
    let abort = false;
    (async () => {
      try {
        const r = await fetch("/api/reports/captions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            title,
            chartType,
            xField,
            yFields,
            data: data.slice(0, 30),
            valueFormat,
          }),
        });
        if (!r.ok) return; // 402 (gated) or 429 — silently skip
        const j = await r.json();
        if (!abort && j?.caption) setCaption({ text: j.caption, source: j.source });
      } catch { /* swallow — caption is decorative */ }
    })();
    return () => { abort = true; };
    // `data` and `yFields` intentionally tracked via their stringified
    // keys — array-identity churn from upstream would otherwise re-fire
    // the network call on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiCaption, print, title, chartType, xField, yFieldsKey, dataKey, valueFormat]);

  // Forecast Accuracy / Trust Layer — record what this render's forecast
  // predicted (see lib/reporting/forecastSnapshot.ts for which points qualify),
  // so it can be graded later once the real value arrives. Fire-and-forget,
  // same contract as the AI caption effect above: a 402 (Growth-tier viewer,
  // gated behind ai.forecast_accuracy) or any network failure just means no
  // history gets recorded for this view — never an error the viewer sees.
  useEffect(() => {
    if (!forecast || print || !reportDbId) return;
    const candidates = buildSnapshotCandidates(data as any[], xField, firstYField);
    if (candidates.length === 0) return;
    let abort = false;
    fetch(`/api/reports/${reportDbId}/forecast-snapshot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        blockId: block.id,
        queryId,
        xField,
        yField: firstYField,
        metricLabel: title || firstYField,
        method: forecast.method,
        candidates,
      }),
    }).catch(() => { /* swallow — recording is best-effort, never blocks the chart */ });
    return () => { abort = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forecast, print, reportDbId, dataKey, xField, firstYField, block.id, queryId, title]);

  // Accuracy badge — how well THIS block's past forecasts have held up.
  // Only fetched when a forecast is actually showing (no point asking for a
  // track record on a chart with the overlay off), and null (not "0%") when
  // there's no history yet or the tenant isn't gated in, so the renderer can
  // tell "no badge" apart from "0% accurate."
  const [accuracy, setAccuracy] = useState<{ hitRatePct: number; total: number } | null>(null);
  useEffect(() => {
    setAccuracy(null);
    if (!forecast || print || !reportDbId) return;
    let abort = false;
    fetch(`/api/reports/${reportDbId}/forecast-accuracy?blockId=${encodeURIComponent(block.id)}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (abort || !j || j.overall.total === 0) return;
        setAccuracy({ hitRatePct: Math.round((j.overall.withinBandCount / j.overall.total) * 100), total: j.overall.total });
      })
      .catch(() => { /* no badge — decorative */ });
    return () => { abort = true; };
  }, [forecast, print, reportDbId, block.id]);

  if (!queryId || data.length === 0) {
    return <BlockEmptyState type="chart" blockId={block.id} title={title} description={t("blockEmpty.noData")} />;
  }

  const fmt = valueFormat ?? "compact";
  // yTickFormatter / tooltipFormatter now computed inside each chart-type
  // renderer (./charts/*.tsx) from the same fmt/currency values.

  // Reference lines render across all chart types that have a Y axis.
  // yAxisId: combo charts declare two NAMED axes ("left"/"right") instead
  // of the single default (id 0) every other chart type uses — Recharts
  // throws ("Could not find yAxis by id 0") if a Reference* element doesn't
  // resolve to one that actually exists. renderComboChart passes "left" for
  // exactly that reason; every other renderer omits it and keeps the old
  // (working) default.
  function renderReferenceLines(yAxisId?: string) {
    if (!referenceLines || referenceLines.length === 0) return null;
    return referenceLines.map((rl: any, i: number) => (
      <ReferenceLine
        key={"rl" + i}
        yAxisId={yAxisId}
        x={rl.axis === "x" ? rl.value : undefined}
        y={rl.axis === "y" ? rl.value : undefined}
        stroke={theme.semantic[rl.variant as keyof typeof theme.semantic] ?? theme.semantic.neutral}
        strokeWidth={1.5}
        strokeDasharray="6 3"
        ifOverflow="extendDomain"
        label={rl.label ? {
          value: rl.label,
          position: "right",
          fill: theme.semantic[rl.variant as keyof typeof theme.semantic] ?? theme.semantic.neutral,
          fontSize: 10,
          fontWeight: 500,
        } : undefined}
      />
    ));
  }

  // Forecast decoration — see PredictionOverlay.tsx. Draws three extras
  // alongside the regular series: a vertical boundary line at the last
  // historical x ("Forecast →" / "AI forecast →"), a shaded band across the
  // projected x-range (if showBands), and — at the band's far edge — the
  // best/worst-case values spelled out as "up to X (+Y%)" / "as low as X
  // (-Y%)" rather than leaving the reader to eyeball the shaded region
  // against the y-axis themselves.
  // Gated on canForecast, not just `forecast` being truthy: computeForecastBoundary
  // only checks `data.length > forecast.periods`, which says nothing about
  // whether `data` actually contains any projected rows (it doesn't, when
  // !canForecast — see `projected` above). Without this guard, a categorical
  // chart with more rows than the viewer's forecast horizon would still draw
  // a "Forecast →" boundary line and label across its last few *real* bars,
  // even after the fake "+1, +2, +3…" bars themselves were suppressed.
  const { boundary: forecastBoundary, end: forecastEnd } = canForecast
    ? computeForecastBoundary(data, forecast, xField)
    : { boundary: undefined, end: undefined };
  const forecastRange = canForecast && forecast?.showBands ? computeForecastRangeSummary(data, firstYField) : null;
  function renderForecastDecor(yAxisId?: string) {
    const label = canForecast && forecast ? t(`forecast.chartLabel.${forecast.method}`) : undefined;
    const rangeLabels = forecastRange ? {
      value: forecastRange.value,
      upperText: t("forecast.rangeBetter")
        .replace("{value}", formatValue(forecastRange.upper, fmt, currency))
        .replace("{pct}", `+${forecastRange.upperDeltaPct.toFixed(0)}%`),
      lowerText: t("forecast.rangeWorse")
        .replace("{value}", formatValue(forecastRange.lower, fmt, currency))
        .replace("{pct}", `-${forecastRange.lowerDeltaPct.toFixed(0)}%`),
    } : undefined;
    return predictionDecorElements(forecast, forecastBoundary, forecastEnd, label, rangeLabels, yAxisId);
  }

  // Event annotations: vertical markers at specific x-values. Match by
  // string equality against xField — keeps date/label format flexibility
  // out of this renderer's hands. Renders as a dashed vertical line with
  // a small label flag at the top, color-coded by variant.
  function renderAnnotations(yAxisId?: string) {
    if (!annotations || annotations.length === 0) return null;
    return annotations.map((a: any, i: number) => {
      const color = theme.semantic[a.variant as keyof typeof theme.semantic] ?? theme.semantic.info;
      const labelText = a.icon ? `${a.icon} ${a.label}` : a.label;
      return (
        <ReferenceLine
          key={"an" + i}
          yAxisId={yAxisId}
          x={a.xValue}
          stroke={color}
          strokeWidth={1.25}
          strokeDasharray="3 4"
          ifOverflow="extendDomain"
          label={{
            value: labelText,
            position: "top",
            fill: color,
            fontSize: 10,
            fontWeight: 600,
          }}
        />
      );
    });
  }

  // Donut is just a Pie with a bigger hole - keep one component, two visual modes.
  const isDonut = chartType === "donut";

  return (
    <div className={cn(
      "group relative flex h-full flex-col overflow-hidden",
      bare ? "p-1" : "rounded-report border border-border bg-card px-5 pb-3 pt-4 shadow-xs",
    )}>
      {!print && (proof || ds || true) && (
        <div className={cn("absolute z-10", bare ? "right-2 top-2" : "right-3 top-3")}>
          <BlockActions>
            <ChartTypeSelector
              current={chartType}
              onChange={setOverrideChartType}
              xField={xField}
              yFields={yFields}
              sizeField={(cfg as any).sizeField}
              rows={datasetEntry ?? []}
            />
            {forecastControlUseful && (
              <ForecastControl
                value={viewerForecastPref}
                onChange={handleForecastChange}
                reportDefault={reportForecast ? { method: reportForecast.method, periods: reportForecast.periods } : undefined}
                unit={forecastCadence.unit}
                accuracy={accuracy}
              />
            )}
            {reportDbId && <AskButton reportId={reportDbId} blockId={block.id} blockType="chart" params={params} />}
            {reportDbId && <CommentButton reportId={reportDbId} blockId={block.id} proofHash={proof?.queryHash} />}
            {reportDbId && <EmbedButton reportId={reportDbId} blockId={block.id} />}
            {ds && <ShowWorkButton ds={ds} rows={data} params={params} />}
            {proof && <ProvenanceBadge record={proof} />}
          </BlockActions>
        </div>
      )}
      {/* Click-to-pin annotations. Sits over the chart surface; only captures
          clicks when pin-mode is on so drill-through and hover tooltips keep
          working the rest of the time. Hidden in print to avoid blue dots
          showing up in PDF/Word exports. */}
      {!print && reportDbId ? (
        <ChartPinOverlay reportId={reportDbId} blockId={block.id} />
      ) : null}
      {!bare && (title || subtitle) && (
        // Same header as the table block: title, then a mono caption naming
        // the chart kind and how many rows it draws.
        <header className="mb-2 flex items-start justify-between gap-3 pr-8">
          <div className="min-w-0">
            {title && (
              <h3 className="flex items-center gap-2 truncate text-base font-semibold tracking-tight text-foreground">
                {title}
                {drillEnabled && (
                  <span data-drill-chip className="rounded-md border border-primary/30 bg-primary-soft px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-primary-ink">
                    click to drill
                  </span>
                )}
              </h3>
            )}
            {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
          </div>
          <span className="shrink-0 pt-1 font-mono text-xs text-faint">{chartType} · {data.length} {t("kpi.rows")}</span>
        </header>
      )}
      {/* In bare mode there's no header reserving space below the floating
          BlockActions toolbar (h-6 trigger + top-2 offset ~= 32px) — without
          this the toolbar sits on top of the chart's own top-right content
          (a legend, the first bars/points) instead of above it. */}
      <div className={"min-h-0 flex-1 " + (bare ? "pt-8 " : "") + cursorClass}>
        {chartType === "gauge" ? (
          renderGaugeChart({
            data, xField, yFields, cfg, palette, style: chartStyle, fmt, currency,
            handleClick, renderReferenceLines, renderAnnotations, renderForecastDecor,
            semantic: theme.semantic,
          })
        ) : chartType === "bullet" ? (
          renderBulletChart({
            data, xField, yFields, cfg, palette, style: chartStyle, fmt, currency,
            handleClick, renderReferenceLines, renderAnnotations, renderForecastDecor,
            semantic: theme.semantic,
          })
        ) : chartType === "sunburst" ? (
          renderSunburstChart({
            data, xField, yFields, cfg, palette, style: chartStyle, fmt, currency,
            handleClick, renderReferenceLines, renderAnnotations, renderForecastDecor,
          })
        ) : chartType === "sankey" ? (
          renderSankeyChart({
            data, xField, yFields, cfg, palette, style: chartStyle, fmt, currency,
            handleClick, renderReferenceLines, renderAnnotations, renderForecastDecor,
          })
        ) : (
        <ResponsiveContainer width="100%" height="100%">
          {chartType === "waterfall" ? (
            renderWaterfallChart({
              data, xField, yFields, cfg, palette, style: chartStyle, fmt, currency, print, showDataLabels,
              handleClick, renderReferenceLines, renderAnnotations, renderForecastDecor,
            })
          ) : chartType === "bar" ? (
            renderBarChart({
              data, xField, yFields, cfg, palette, style: chartStyle, fmt, currency, print, showLegend, showDataLabels,
              gid, stacked, forecast, handleClick, renderReferenceLines, renderAnnotations, renderForecastDecor,
            })
          ) : chartType === "line" ? (
            renderLineChart({
              data, xField, yFields, cfg, palette, style: chartStyle, fmt, currency, print, showLegend, showDataLabels,
              forecast, handleClick, renderReferenceLines, renderAnnotations, renderForecastDecor,
            })
          ) : chartType === "area" ? (
            renderAreaChart({
              data, xField, yFields, cfg, palette, style: chartStyle, fmt, currency, print, showLegend,
              gid, stacked, forecast, handleClick, renderReferenceLines, renderAnnotations, renderForecastDecor,
            })
          ) : chartType === "combo" ? (
            renderComboChart({
              data, xField, yFields, cfg, palette, style: chartStyle, fmt, currency, print, showLegend, showDataLabels,
              gid, lineFields, forecast, handleClick, renderReferenceLines, renderAnnotations, renderForecastDecor,
            })
          ) : chartType === "treemap" ? (
            renderTreemapChart({
              data, xField, yFields, cfg, palette, style: chartStyle, fmt, currency, print,
              handleClick, renderReferenceLines, renderAnnotations, renderForecastDecor,
            })
          ) : chartType === "funnel" ? (
            renderFunnelChart({
              data, xField, yFields, cfg, palette, style: chartStyle, fmt, currency, print, showDataLabels,
              handleClick, renderReferenceLines, renderAnnotations, renderForecastDecor,
              ramp: theme.ramps.primary, semantic: theme.semantic,
            })
          ) : chartType === "scatter" ? (
            renderScatterChart({
              data, xField, yFields, cfg, palette, style: chartStyle, fmt, currency, print, showLegend,
              handleClick, renderReferenceLines, renderAnnotations, renderForecastDecor,
            })
          ) : chartType === "radar" ? (
            renderRadarChart({
              data, xField, yFields, cfg, palette, style: chartStyle, fmt, currency, print, showLegend,
              handleClick, renderReferenceLines, renderAnnotations, renderForecastDecor,
            })
          ) : chartType === "streamgraph" ? (
            renderStreamgraphChart({
              data, xField, yFields, cfg, palette, style: chartStyle, fmt, currency, print, showLegend,
              gid, handleClick, renderReferenceLines, renderAnnotations, renderForecastDecor,
            })
          ) : (
            renderPieChart({
              data, xField, yFields, cfg, palette, style: chartStyle, fmt, currency, print, showLegend, showDataLabels,
              handleClick, renderReferenceLines, renderAnnotations, renderForecastDecor,
              gid, isDonut, drillEnabled, onDrill: onDrill ?? undefined, blockId: block.id,
            })
          )}
        </ResponsiveContainer>
        )}
      </div>
      {/* AI caption strip — only renders when (a) the block has aiCaption: true,
          (b) the tenant is on Business (the API 402s otherwise — we never
          show the strip in that case), and (c) the caption call returned
          something. The Sparkles icon signals "this is AI commentary" so
          readers don't confuse it with hand-edited copy. */}
      {/* AI caption strip rendered when present. */}
      {caption && !print && (
        <div className="mt-2 flex items-start gap-1.5 rounded-md border border-primary/30 bg-primary-soft px-2.5 py-1.5 text-[11px] leading-relaxed text-primary-ink   ">
          <Sparkles className="mt-[1px] h-3 w-3 shrink-0 text-primary" />
          <span className="italic">
            {caption.text}
            {caption.source === "rule" && (
              <span className="ml-1 not-italic text-[10px] text-primary/70">(deterministic)</span>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
