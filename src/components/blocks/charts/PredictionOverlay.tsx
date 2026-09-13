/**
 * PredictionOverlay — shared forecast-rendering pieces for ChartBlock and the
 * KPI sparkline, so every chart type styles a projection the same way instead
 * of each renderer inventing its own dashed-line convention.
 *
 * Exports two kinds of thing:
 *   - Pure helpers (computeForecastBoundary, splitForecastSeries) — no React,
 *     no Recharts, safe to unit test directly.
 *   - predictionDecorElements — the Recharts ReferenceLine/ReferenceArea pair drawn
 *     behind the series to mark where the projection starts.
 */
import type { ReactElement } from "react";
import { ReferenceArea, ReferenceLine } from "recharts";
import type { ForecastConfig } from "@/lib/reporting/schema";

/**
 * One fixed accent for every predicted element — the boundary marker, the
 * dashed line/area tail, the dimmed bar cells, the KPI sparkline tail — so
 * "this is a projection, not measured data" reads instantly, everywhere,
 * without depending on subtler cues like opacity or dash pattern alone.
 * Deliberately NOT reused from the categorical palette (DEFAULT_PALETTE in
 * ChartBlock.tsx) — if a series happened to use the same hue, a merely-dimmed
 * version of it would blend in instead of standing apart.
 */
export const FORECAST_COLOR = "#8b5cf6"; // violet-500
export const FORECAST_LABEL_COLOR = "#7c3aed"; // violet-600, darker for label legibility
export const FORECAST_BAND_FILL = "#8b5cf6"; // paired with a low fillOpacity for the shaded region

/**
 * Given a dataset that may have forecast rows appended (via
 * `withForecast`/`projectSeries`, flagged with `__forecast: true`), find the
 * x-axis label of the last historical point (`boundary`, where the dashed
 * continuation should start) and the last projected point (`end`, where the
 * shaded band should stop).
 *
 * Returns `{ boundary: undefined, end: undefined }` when there's nothing to
 * project (no forecast config, or fewer rows than requested periods).
 */
export function computeForecastBoundary(
  data: Array<Record<string, unknown>>,
  forecast: ForecastConfig | undefined,
  xField: string,
): { boundary: unknown; end: unknown } {
  if (!forecast || data.length <= forecast.periods) return { boundary: undefined, end: undefined };
  return {
    boundary: data[data.length - forecast.periods - 1]?.[xField],
    end: data[data.length - 1]?.[xField],
  };
}

/**
 * Adds two synthetic per-row fields so a solid "actual" segment and a dashed
 * "predicted" segment can render as two `<Line>`/`<Area>` series over the
 * SAME data array, instead of two separately-sliced arrays.
 *
 * This matters specifically because the x-axis here is categorical (dates as
 * string labels, not a numeric scale). Recharts computes a categorical axis's
 * domain by walking every graphical item's OWN `data` prop — if two series
 * are handed different (even overlapping) slices of the array, the shared
 * boundary category ends up registered twice, corrupting the domain for
 * EVERY item on the chart (verified in the browser: the x-axis grew a
 * duplicate tick for the boundary date, and every ReferenceLine's x lookup
 * against it resolved to NaN). Feeding both series the identical full-length
 * array — same order, same category values, only differing in which cells
 * are `undefined` — keeps the category domain to exactly one entry per row.
 *
 * Returns rows unchanged (no new fields) when there's no forecast data.
 * The boundary row (last historical point) carries BOTH `[yField]` and
 * `[yField]__predicted` so the two segments visually connect with no gap.
 */
export function buildForecastFields<T extends Record<string, unknown>>(
  data: T[],
  yField: string,
): Array<T & Record<string, unknown>> {
  const splitIdx = data.findIndex((r) => (r as any).__forecast === true);
  if (splitIdx === -1) return data;
  const predictedField = `${yField}__predicted`;
  return data.map((row, i) => {
    if (i < splitIdx - 1) return row;
    if (i < splitIdx) return { ...row, [predictedField]: row[yField] }; // boundary row: both fields
    return { ...row, [yField]: undefined, [predictedField]: row[yField] };
  });
}

export type ForecastRangeSummary = {
  value: number;
  upper: number;
  lower: number;
  /** Positive percent the final point could beat the point forecast by. */
  upperDeltaPct: number;
  /** Positive percent the final point could fall short of the point forecast by. */
  lowerDeltaPct: number;
};

/**
 * Reads the confidence-band width at the LAST projected point, expressed as
 * "how much better/worse than the point forecast could this realistically
 * turn out" — the number a reader actually wants next to a forecast, not
 * just a shaded band they have to eyeball against the y-axis themselves.
 *
 * Returns null when there's no terminal forecast row, or when its own
 * predicted value is 0 (a percent delta off zero is meaningless).
 */
export function computeForecastRangeSummary(
  data: Array<Record<string, unknown>>,
  yField: string,
): ForecastRangeSummary | null {
  const last = data[data.length - 1] as Record<string, unknown> | undefined;
  if (!last || (last as any).__forecast !== true) return null;
  const value = Number(last[yField]);
  const upper = Number((last as any).__upper);
  const lower = Number((last as any).__lower);
  if (!Number.isFinite(value) || !Number.isFinite(upper) || !Number.isFinite(lower) || value === 0) return null;
  return {
    value, upper, lower,
    upperDeltaPct: ((upper - value) / Math.abs(value)) * 100,
    lowerDeltaPct: ((value - lower) / Math.abs(value)) * 100,
  };
}

/**
 * Deliberately a plain function, NOT a React component — Recharts detects
 * ReferenceLine/ReferenceArea by inspecting the chart's direct children
 * (React.Children.toArray, which flattens arrays but does not reach inside a
 * custom component's render output). Wrapping these in `<SomeComponent>`
 * makes Recharts treat them as an opaque, unrecognized child: they mount but
 * never get positioned against the chart's axes. Returning a plain array
 * that gets spread as `{predictionDecorElements(...)}` keeps them as direct,
 * recognizable children — same shape the inline version used before this
 * was extracted into a shared module.
 */
export function predictionDecorElements(
  forecast: ForecastConfig | undefined,
  boundary: unknown,
  end: unknown,
  // Pre-translated boundary label ("Forecast →" / localized equivalent).
  // This function is a plain function, not a component (see docstring
  // above), so it can't call useT() itself — the caller (which IS a
  // component) resolves the locale and passes the string in. Defaults to
  // the English copy so existing callers/tests that don't pass one keep
  // working unchanged.
  label?: string,
  // Pre-formatted "up to X (+Y%)" / "as low as X (-Y%)" text — pre-formatted
  // by the caller (ChartBlock.tsx) the same way `label` is, since this
  // module has no access to useT()/currency/fmt.
  rangeLabels?: { value: number; upperText: string; lowerText: string },
  // Combo charts declare two NAMED y-axes ("left"/"right") instead of the
  // single default (id 0) every other chart type uses; Recharts throws
  // ("Could not find yAxis by id 0") if these elements don't resolve to an
  // axis that actually exists on the chart. The caller passes "left" only
  // for combo charts — every other chart type omits this and keeps the
  // default that already worked.
  yAxisId?: string,
): ReactElement[] {
  if (!forecast || boundary === undefined) return [];
  const boundaryLabel = label ?? (forecast.method === "llm" ? "AI forecast →" : forecast.method === "ets" ? "Smoothed forecast →" : "Forecast →");
  return [
    <ReferenceLine
      key="forecast-boundary"
      yAxisId={yAxisId}
      x={boundary as any}
      stroke={FORECAST_COLOR}
      strokeWidth={1.5}
      strokeDasharray="2 4"
      ifOverflow="extendDomain"
      label={{
        value: boundaryLabel,
        position: "insideTopRight",
        fill: FORECAST_LABEL_COLOR,
        fontSize: 10,
        fontWeight: 600,
      }}
    />,
    ...(forecast.showBands && end !== undefined ? [
      <ReferenceArea
        key="forecast-band"
        yAxisId={yAxisId}
        x1={boundary as any}
        x2={end as any}
        ifOverflow="extendDomain"
        fill={FORECAST_BAND_FILL}
        fillOpacity={0.08}
        stroke="none"
        // Best/worst-case text anchored to the shaded band's OWN top-right
        // corner (viewBox here is the area's real pixel rect — x/y/width/
        // height — not a single point), same mechanism as the "Forecast →"
        // boundary label above. Two earlier attempts anchored the text to
        // the terminal DATA VALUE instead: one sat close enough to the
        // plotted line/bars to collide with them, the other (a volatile
        // series whose linear-regression bound shot past the visible range)
        // pushed the label off-canvas. Anchoring to the band's geometry
        // instead of a data value can't drift into either failure — the top
        // of the plot is always visible and never where a bar/line sits.
        label={forecast.showBands && rangeLabels ? (props: any) => {
          const vb = props.viewBox ?? { x: 0, y: 0, width: 0 };
          const x = vb.x + vb.width - 4;
          return (
            <>
              <text x={x} y={vb.y + 12} textAnchor="end" fill={FORECAST_LABEL_COLOR} fontSize={10} fontWeight={600}>
                {rangeLabels.upperText}
              </text>
              <text x={x} y={vb.y + 26} textAnchor="end" fill={FORECAST_LABEL_COLOR} fontSize={10} fontWeight={600}>
                {rangeLabels.lowerText}
              </text>
            </>
          );
        } : undefined}
      />,
    ] : []),
  ];
}
