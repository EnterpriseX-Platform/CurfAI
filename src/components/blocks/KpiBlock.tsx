"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ExternalLink, Loader2, Play, X } from "lucide-react";
import { formatCurrency, formatNumber, formatPercent, isIdentifierLabel } from "@/lib/reporting/format";
import { projectSeries, projectSeriesETS } from "@/lib/reporting/forecast";
import { FORECAST_COLOR } from "./charts/PredictionOverlay";
import type { ForecastConfig } from "@/lib/reporting/schema";
import type { ProvenanceRecord } from "@/lib/reporting/provenance";
import { currencySymbol } from "@/lib/reporting/currency";
import { computeKpiValue, kpiDelta, pickKpiCompare } from "@/lib/reporting/kpi";
import type { BlockRenderContext } from "./types";
import { ProvenanceBadge } from "./ProvenanceBadge";
import { ShowWorkButton } from "./ShowWorkButton";
import { AskButton } from "./AskButton";
import { eeClient } from "@/ee/client";

const AskWhyButton = eeClient.reports?.AskWhyButton ?? null;
import { CommentButton } from "./CommentButton";
import { BlockActions } from "./BlockActions";
import { BlockEmptyState } from "./BlockEmptyState";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/components/providers/ThemeProvider";
import { useCurrency } from "@/components/providers/CurrencyProvider";
import { useT } from "@/lib/i18n/LocaleContext";
import {
  shouldAnimateCountUp, tierFor, type Tier,
  KpiCardFrame, KpiLabel, KpiValue, KpiDelta, KpiReceipt,
} from "./kpiCard";

// Re-exported so existing imports (kpiCountUp.test.ts) keep working — the
// implementation moved to kpiCard.tsx, the shared card module BriefKpiCard
// also consumes.
export { shouldAnimateCountUp };

/**
 * Extends a KPI sparkline's values with a projection, same math as the
 * chart-level forecast (see lib/reporting/forecast.ts). Returns the
 * trailing `forecastCount` so the renderer knows how many points at the
 * end of `values` are predicted rather than observed.
 *
 * "llm" isn't supported here (that path needs an async server round trip;
 * a sparkline's tiny footprint doesn't justify one) — it silently falls
 * back to "linear" rather than showing nothing.
 *
 * Exported for tests — pure, no React/DOM dependency.
 */
export function buildSparkSeries(
  sparkValues: number[],
  forecast: ForecastConfig | undefined,
): { values: number[]; forecastCount: number } {
  if (!forecast || sparkValues.length < 2) return { values: sparkValues, forecastCount: 0 };
  const rows = sparkValues.map((v) => ({ v }));
  const projected = forecast.method === "ets"
    ? projectSeriesETS(rows, "v", forecast.periods)
    : projectSeries(rows, "v", forecast.periods);
  if (projected.length === 0) return { values: sparkValues, forecastCount: 0 };
  return {
    values: [...sparkValues, ...projected.map((p) => Number(p.v))],
    forecastCount: projected.length,
  };
}

const toRgba = (hex: string, a: number) => {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

/**
 * Trend sparkline: fills the card's width (measured, so the geometry is
 * exact and nothing is stretched), faint gridlines, a 10% area under the
 * observed line and an emphasised endpoint. Colour flips on whether the
 * trend is rising and whether rising is "good" — churn turns red as it
 * climbs.
 *
 * `forecastCount` marks the trailing N values as predicted: that tail is a
 * dashed continuation with a hollow end marker, so a glance can't mistake a
 * projection for a measurement.
 *
 * `endIndex` (time-travel replay) treats that point as "now": the line is
 * drawn up to it, the endpoint sits on it, and what came later is a faint
 * dashed ghost.
 */
export function Sparkline({
  values, positive = "up", height = 36, goodColor = "#0E7C5B", badColor = "#B4304A", forecastCount = 0, endIndex,
}: {
  values: number[];
  positive?: "up" | "down";
  height?: number;
  goodColor?: string;
  badColor?: string;
  forecastCount?: number;
  endIndex?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setWidth(Math.round(w));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!values.length) return null;
  const n = values.length;
  const replaying = endIndex != null;
  const end = replaying ? Math.max(0, Math.min(n - 1, endIndex)) : n - 1;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const padX = 3, padTop = 5, padBottom = 3;
  const X = (i: number) => (n > 1 ? padX + (i * (width - 2 * padX)) / (n - 1) : width / 2);
  const Y = (v: number) => padTop + (1 - (v - min) / range) * (height - padTop - padBottom);
  const pts = values.map((v, i) => [X(i), Y(v)] as const);
  const splitIdx = forecastCount > 0 ? Math.max(0, n - forecastCount - 1) : n - 1;
  const observedEnd = replaying ? end : Math.min(end, splitIdx);
  const observed = pts.slice(0, observedEnd + 1);
  const forecastPts = forecastCount > 0 && !replaying ? pts.slice(splitIdx) : [];
  const ghost = replaying && end < n - 1 ? pts.slice(end) : [];
  const rising = values[end] >= values[0];
  const good = rising === (positive === "up");
  const stroke = good ? goodColor : badColor;
  const toPath = (p: readonly (readonly [number, number])[]) =>
    p.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const d = toPath(observed);
  const baseline = height - padBottom;
  const area = observed.length > 1
    ? `${d} L${observed[observed.length - 1][0].toFixed(1)},${baseline} L${observed[0][0].toFixed(1)},${baseline} Z`
    : "";
  // Marker sits on the predicted end when a forecast tail exists (hollow),
  // otherwise on "now" (filled), ringed in the card colour so it reads
  // over the line.
  const forecastEnd = forecastCount > 0 && !replaying;
  const marker = pts[forecastEnd ? n - 1 : end];
  return (
    <div ref={wrapRef} className="w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block overflow-visible">
          <title>{forecastEnd ? `Trend — last ${forecastCount} point${forecastCount === 1 ? "" : "s"} predicted (dashed)` : "Trend"}</title>
          {[0.25, 0.5, 0.75].map((f) => {
            const y = (padTop + f * (height - padTop - padBottom)).toFixed(1);
            return <line key={f} x1={0} x2={width} y1={y} y2={y} stroke="hsl(var(--border))" strokeWidth={1} />;
          })}
          {ghost.length > 1 && (
            <path d={toPath(ghost)} fill="none" stroke="hsl(var(--border))" strokeWidth={1.5} strokeDasharray="3 3" strokeLinejoin="round" />
          )}
          {area && <path d={area} fill={toRgba(stroke, 0.1)} stroke="none" />}
          <path d={d} fill="none" stroke={stroke} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
          {forecastPts.length > 1 && (
            // Fixed forecast accent, not the actual/predicted-good/bad stroke —
            // same convention as the chart-level overlay (PredictionOverlay.tsx),
            // so "predicted" reads as one consistent color everywhere in the app.
            <path d={toPath(forecastPts)} fill="none" stroke={FORECAST_COLOR} strokeDasharray="3 2" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
          )}
          <circle
            cx={marker[0]} cy={marker[1]} r={3}
            fill={forecastEnd ? "hsl(var(--card))" : stroke}
            stroke={forecastEnd ? FORECAST_COLOR : "hsl(var(--card))"}
            strokeWidth={forecastEnd ? 1.5 : 2}
          />
        </svg>
      )}
    </div>
  );
}

/** Compact a large currency/number for narrow KPI cards: 17122163.93 -> $17.1M */
function compactCurrency(n: number, format: "currency" | "number", currency?: string): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  let suffix = "";
  let scaled = n;
  if (abs >= 1e12) { scaled = n / 1e12; suffix = "T"; }
  else if (abs >= 1e9)  { scaled = n / 1e9;  suffix = "B"; }
  else if (abs >= 1e6)  { scaled = n / 1e6;  suffix = "M"; }
  else if (abs >= 1e3)  { scaled = n / 1e3;  suffix = "K"; }
  else return format === "currency" ? formatCurrency(n, currency) : formatNumber(n);
  const trimmed = Math.abs(scaled).toFixed(1).replace(/\.0$/, "");
  return format === "currency"
    ? `${sign}${currencySymbol(currency ?? "USD")}${trimmed}${suffix}`
    : `${sign}${trimmed}${suffix}`;
}

// Tier/tierFor/VALUE_PX moved to kpiCard.tsx (shared with BriefKpiCard) —
// see that module's docblock for the tier table. SPARK_PX stays here: the
// sparkline height budget is specific to a report-tab KPI block's grid
// geometry, not something the Brief's headline card shares.
//
// Budgeted against the tier's grid height with 14px vertical padding and
// 6px gaps — the hero row (header 16 · value 42 · delta 17 · spark 44 ·
// receipt 16 · actions 28) lands at ~238px of its 240px.
const SPARK_PX: Record<Tier, number> = { tiny: 0, compact: 0, mid: 36, tall: 44, hero: 44 };

/** One point of the KPI's time-travel series — see /api/reports/[id]/kpi-history. */
type HistoryPoint = {
  runId: string;
  at: string;
  value: number;
  compare: number | null;
  dataHash: string | null;
  queryHash: string | null;
  rowCount: number;
  runAt: string;
};

// Hashes are stored as "sha256:<hex>"; the receipt prints the algorithm
// itself, so only the hex is shortened: sha256 3f9a…c2.
const shortHash = (h: string | null | undefined) => {
  if (!h) return "—";
  const hex = h.replace(/^sha256:/i, "");
  return `${hex.slice(0, 4)}…${hex.slice(-2)}`;
};

export function KpiBlock(props: BlockRenderContext) {
  if (props.block.type !== "kpi") return null;
  return <KpiBlockInner {...props} block={props.block} />;
}

type KpiInnerProps = Omit<BlockRenderContext, "block"> & { block: Extract<BlockRenderContext["block"], { type: "kpi" }> };

function KpiBlockInner({ block, dataset, provenance, print, report, params, reportDbId, bare }: KpiInnerProps) {
  const cfg = block.config;
  const { queryId, label, valueField, format, compareField, prefix, suffix,
          sparkQueryId, sparkValueField, sparkPositive, aggregate, forecast } = cfg;
  // Sparkline + delta colors come from theme.semantic (theme-invariant by
  // design — meaning shouldn't shift with the chart palette).
  const theme = useTheme();
  const currency = useCurrency();
  const { t, locale } = useT();
  // Time-travel replay: the KPI's daily snapshot series, fetched once on
  // first use; `replayIndex` is the day being looked at (null = live).
  const [history, setHistory] = useState<HistoryPoint[] | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [replayIndex, setReplayIndex] = useState<number | null>(null);
  // Clock strings (run 06:05, "as of 8 Sep") are rendered only after mount:
  // the server formats them in its own zone, the browser in the viewer's,
  // and a mismatch would fail hydration for the whole card.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const datasetEntry = dataset[queryId];

  if (!queryId || !datasetEntry || datasetEntry.length === 0) {
    return <BlockEmptyState type="kpi" blockId={block.id} title={label} description={t("blockEmpty.noData")} />;
  }

  const rows = datasetEntry as Array<Record<string, unknown>>;
  const liveValue = computeKpiValue({ valueField, aggregate }, rows);
  const liveCompare = pickKpiCompare(rows, compareField);

  // Sparkline values come from a separate query - usually a date-bucketed
  // time-series for the same metric. Filtered out non-numeric rows so a
  // missing-data day doesn't break the path.
  let sparkValues: number[] = [];
  if (sparkQueryId && sparkValueField) {
    sparkValues = (dataset[sparkQueryId] ?? [])
      .map((r) => Number((r as any)[sparkValueField]))
      .filter((n) => Number.isFinite(n));
  }
  const { values: sparkSeries, forecastCount } = buildSparkSeries(sparkValues, forecast);

  const replayOpen = replayIndex != null;
  const point = replayOpen && history && history.length > 0
    ? history[Math.max(0, Math.min(replayIndex, history.length - 1))]
    : null;
  const pointIdx = point && history ? history.indexOf(point) : -1;
  const value = point ? point.value : liveValue;
  // A replayed day compares against its own stored comparison when the
  // query carries one, else against the previous snapshot.
  const compare = point
    ? (point.compare ?? (pointIdx > 0 && history ? history[pointIdx - 1].value : undefined))
    : liveCompare;
  const delta = kpiDelta(value, compare);

  // Full precision is kept for the hover tooltip. For the *primary* display we
  // use the compact form (17M, 94B, 2.3K) whenever the magnitude is big enough
  // to matter — this is the honest format for a dashboard card: it never
  // truncates, it fits at every card width, and it reads faster at a glance.
  const full =
    !Number.isFinite(value)
      ? "—"
      : format === "currency"
        ? formatCurrency(value, currency)
        : format === "percent"
          ? formatPercent(value)
          : formatNumber(value);

  const tier = tierFor(block.h, !!bare);
  // The full figure (1,284,300) is what a provenance card should show; cards
  // compact (1.3M) only when the string genuinely wouldn't fit — tall/hero
  // cards have room for nine digits, smaller ones for a short figure like
  // 3,412 — so the number never truncates.
  const roomForFull = full.length <= ((tier === "tall" || tier === "hero") ? 12 : 7);
  const useCompact =
    Number.isFinite(value) &&
    (format === "currency" || format === "number") &&
    Math.abs(value) >= 1000 &&
    !isIdentifierLabel(label) &&
    !roomForFull;
  const display = useCompact ? compactCurrency(value, format as "currency" | "number", currency) : full;

  // Frame-by-frame formatter for the count-up animation. Mirrors the
  // logic above so every interpolated step reads correctly.
  const formatFrame = (n: number) => {
    if (!Number.isFinite(n)) return "—";
    if (
      (format === "currency" || format === "number") &&
      Math.abs(n) >= 1000 &&
      !isIdentifierLabel(label) &&
      !roomForFull
    ) {
      return compactCurrency(n, format as "currency" | "number", currency);
    }
    if (format === "currency") return formatCurrency(n, currency);
    if (format === "percent")  return formatPercent(n);
    return formatNumber(n);
  };

  // The proof is read in print too — that is what puts the run receipt on
  // the PDF. Only the interactive affordances are print-suppressed.
  const proof: ProvenanceRecord | undefined = provenance?.[queryId];
  const ds = !print ? report.dataSources.find((d) => d.id === queryId) ?? null : null;
  const receipt = point
    ? { hash: point.dataHash, runAt: point.runAt, rows: point.rowCount }
    : proof
      ? { hash: proof.dataHash, runAt: proof.runAt, rows: proof.rowCount }
      : null;

  const showDelta = tier !== "tiny" && delta !== undefined && Number.isFinite(delta);
  const showSpark = SPARK_PX[tier] > 0;
  const showReceipt = (tier === "tall" || tier === "hero") && !!receipt;
  const showActions = tier === "hero" && !print && !!reportDbId && !replayOpen;
  const sparkForRender = point && history ? history.map((p) => p.value) : sparkSeries;
  const sparkEnd = point ? pointIdx : undefined;
  const sparkHeight = replayOpen ? Math.min(SPARK_PX[tier], 40) : SPARK_PX[tier];

  const fmtDay = (iso: string) => (mounted ? new Date(iso).toLocaleDateString(locale, { day: "numeric", month: "short" }) : "");
  // 24-hour clock in every locale — a receipt reads "run 06:05", not "06:05 AM".
  const fmtTime = (iso: string) => (mounted ? new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "—:—");

  async function startReplay() {
    if (!reportDbId || historyBusy) return;
    if (history) { setReplayIndex(Math.max(0, history.length - 1)); return; }
    setHistoryBusy(true);
    setReplayIndex(0);
    try {
      const r = await fetch(`/api/reports/${reportDbId}/kpi-history?blockId=${encodeURIComponent(block.id)}&days=14`, { cache: "no-store" });
      const j = r.ok ? await r.json() : null;
      const pts: HistoryPoint[] = Array.isArray(j?.points) ? j.points : [];
      setHistory(pts);
      setReplayIndex(Math.max(0, pts.length - 1));
    } catch {
      setHistory([]);
    } finally {
      setHistoryBusy(false);
    }
  }
  const exitReplay = () => setReplayIndex(null);

  // Direction semantics: `sparkPositive: "down"` says falling is good (churn,
  // refund rate), so the delta's colour follows the same rule as the line.
  const deltaGood = showDelta ? (delta! >= 0) === ((sparkPositive ?? "up") === "up") : true;
  // A rate moves in points (1.8% vs 2.1% is "▼ 0.3 pt"), not in percent of
  // a percent — the relative form reads as a much bigger move than it is.
  const deltaText = !showDelta
    ? ""
    : format === "percent" && compare != null
      ? `${Math.abs((value - compare) * 100).toFixed(1)} pt`
      : formatPercent(Math.abs(delta!));
  return (
    <KpiCardFrame tier={tier} bare={bare}>
      {/* Header: label, then the verified seal (opens the proof) and the ⋯
          actions. Everything on one line so nothing overlaps the value. */}
      <KpiLabel
        tier={tier}
        title={label}
        trailing={
          <>
            {proof && <ProvenanceBadge record={proof} variant="seal" title={t("kpi.verified")} />}
            {!print && (ds || reportDbId) && (
              <BlockActions>
                {reportDbId && <AskButton reportId={reportDbId} blockId={block.id} blockType="kpi" params={params} />}
                {reportDbId && <CommentButton reportId={reportDbId} blockId={block.id} proofHash={proof?.queryHash} />}
                {ds && <ShowWorkButton ds={ds} rows={rows} params={params} />}
              </BlockActions>
            )}
          </>
        }
      />

      <KpiValue value={value} format={formatFrame} display={display} tier={tier} prefix={prefix} suffix={suffix} title={full} />

      {showDelta && (
        <KpiDelta dir={delta! >= 0 ? "up" : "down"} good={deltaGood} text={deltaText} caption={t("kpi.vsPrior")} />
      )}

      {showSpark && sparkForRender.length > 1 && (
        <Sparkline
          values={sparkForRender}
          positive={sparkPositive ?? "up"}
          height={sparkHeight}
          goodColor={theme.semantic.success}
          badColor={theme.semantic.danger}
          forecastCount={point ? 0 : forecastCount}
          endIndex={sparkEnd}
        />
      )}

      {replayOpen && (
        <div className="rounded-md bg-muted px-2.5 py-1.5">
          {history && history.length >= 2 && point ? (
            <>
              <input
                type="range"
                min={0}
                max={history.length - 1}
                value={pointIdx}
                onChange={(e) => setReplayIndex(Number(e.target.value))}
                aria-label={t("kpi.replay")}
                className="block h-3 w-full cursor-pointer accent-primary"
              />
              <div className="mt-0.5 flex items-center justify-between gap-2 font-mono text-[11px] text-muted-foreground">
                <span className="tabular-nums">{fmtDay(history[0].at)}</span>
                <span className="rounded-sm bg-primary-soft px-1.5 py-px font-medium text-primary-ink">
                  {t("kpi.asOf")} {fmtDay(point.at)}
                </span>
                <span className="flex items-center gap-1 tabular-nums">
                  {fmtDay(history[history.length - 1].at)}
                  {reportDbId && (
                    <Link
                      href={`/reports/${reportDbId}?replay=${point.runId}`}
                      title={t("kpi.openSnapshot")}
                      className="ml-1 rounded-sm p-0.5 text-primary hover:bg-primary-soft"
                    >
                      <ExternalLink className="h-3 w-3" />
                    </Link>
                  )}
                  <button type="button" onClick={exitReplay} title={t("kpi.exitReplay")} aria-label={t("kpi.exitReplay")} className="rounded-sm p-0.5 hover:bg-card hover:text-foreground">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                {historyBusy && <Loader2 className="h-3 w-3 animate-spin" />}
                {historyBusy ? t("kpi.loadingHistory") : t("kpi.noHistory")}
              </span>
              {!historyBusy && (
                <button type="button" onClick={exitReplay} aria-label={t("kpi.exitReplay")} className="rounded-sm p-0.5 hover:bg-card hover:text-foreground">
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {showReceipt && receipt && (
        <KpiReceipt hash={receipt.hash}>
          sha256 {shortHash(receipt.hash)} · {t("kpi.run")} {fmtTime(receipt.runAt)} · {formatNumber(receipt.rows)} {t("kpi.rows")}
        </KpiReceipt>
      )}

      {showActions && (
        <div className="mt-auto flex flex-wrap items-center gap-2">
          {AskWhyButton && <AskWhyButton
            variant="button"
            reportId={reportDbId!}
            blockId={block.id}
            label={String(label)}
            currentFormatted={display}
            deltaPct={delta ?? null}
          />}
          <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 px-2.5 text-xs" onClick={startReplay} disabled={historyBusy}>
            {historyBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            {t("kpi.replay")}
          </Button>
        </div>
      )}
    </KpiCardFrame>
  );
}
