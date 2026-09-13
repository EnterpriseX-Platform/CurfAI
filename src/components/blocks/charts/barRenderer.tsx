/**
 * Bar chart JSX, extracted verbatim out of ChartBlock.tsx — same pattern as
 * the other files in this directory (plain function called inline, not a
 * separate React component).
 *
 * Colour on a bar means something — a category the author asked for, or a
 * forecast — never decoration: there is no automatic "hot/warm" tinting here.
 * A short horizontal single-series chart reads as a ranked list: the value
 * written at the end of each bar and no numeric axis to read across to.
 *
 * Geometry (radius, gradient vs flat, ghost track, bar size, whether the value
 * axis is drawn at all) comes from the resolved chart style — see
 * lib/reporting/chartStyles.ts. Bars are flat under "classic", which is the
 * default and the fallback for an unknown slug, so this file renders exactly
 * as it always did unless a workspace opts into another style. Read tokens
 * here; never branch on `style.slug`.
 */
import type { ReactElement } from "react";
import {
  BarChart, Bar, Cell, CartesianGrid, Legend, Tooltip, XAxis, YAxis, LabelList, Rectangle,
} from "recharts";
import {
  AXIS_PROPS, Y_AXIS_DOMAIN, Y_AXIS_WIDTH, TOOLTIP_STYLE, LABEL_FILL, CURSOR_FILL, LEGEND_STYLE,
  formatValue, styleOf, gridPropsFor, DEEMPHASIS_FILL, type ChartRenderCtx,
} from "./shared";
import { SeriesGradients, seriesFill } from "./gradients";
import { directLabelsFit } from "@/lib/reporting/chartStyles";
import { FORECAST_COLOR } from "./PredictionOverlay";

export function renderBarChart(ctx: ChartRenderCtx): ReactElement {
  const {
    data, xField, yFields, palette, fmt, currency, print, showLegend, showDataLabels,
    stacked, cfg, gid, forecast, handleClick, renderReferenceLines, renderAnnotations, renderForecastDecor,
  } = ctx;
  const style = styleOf(ctx);
  const categoricalColor = cfg?.categoricalColor as boolean | undefined;
  const emphasisTop = cfg?.emphasisTop as number | undefined;
  const yTickFormatter = (v: number) => formatValue(v, fmt, currency);
  const tooltipFormatter = (v: any) => [formatValue(Number(v), fmt, currency), ""];
  const rows = data as any[];

  // Horizontal bars: Recharts spells this `layout="vertical"` (it describes
  // the axis stack, not the bars), the axes swap roles, and the corner
  // radius runs left-to-right instead of top-down.
  const horizontal = cfg?.orientation === "horizontal";
  const isSingleSeries = yFields.length === 1 && !stacked;
  // A short horizontal single-series chart is a ranked list: label every bar
  // by default (the author can still switch labels off) and let the labels
  // stand in for the value axis and its grid.
  const ranked = horizontal && isSingleSeries && rows.length <= 12;
  // Modern/Enterprise ask for labels on every chart, but only where they'd
  // actually fit — past ~12 categories, or on grouped/stacked series, they
  // collide and the axis is the better read.
  const styleWantsLabels = style.forceDataLabels && directLabelsFit(rows.length, isSingleSeries);
  const labels = showDataLabels ?? (ranked || styleWantsLabels);
  const listMode = horizontal && labels;
  // Dropping the value axis is only safe once labels are actually carrying the
  // numbers — otherwise the chart loses its scale entirely.
  const hideValueAxis = !style.valueAxis && labels && isSingleSeries;
  const r = style.bar.radius;
  // A pill is a full-height radius, so it only reads as one on a thin
  // horizontal bar — capped at half the bar thickness or it clips.
  const hBarSize = style.bar.maxBarSize.horizontal;
  const hRadius = style.bar.pill ? Math.min(r, hBarSize / 2) : r;
  const barRadius: [number, number, number, number] = horizontal
    ? (style.bar.pill ? [hRadius, hRadius, hRadius, hRadius] : [0, hRadius, hRadius, 0])
    : [r, r, 0, 0];
  const showTrack = style.bar.track === "always"
    ? isSingleSeries
    : style.bar.track === "list" ? listMode : false;
  // Grid lines exist to read a mark back to the value axis. With the axis
  // hidden and the numbers written on the marks themselves there is nothing
  // left to read them against, so they are just lines across the plot.
  const gridProps = hideValueAxis
    ? null
    : gridPropsFor(style, { vertical: horizontal, horizontal: !horizontal });
  // Category labels need real room when they run down the side.
  const CATEGORY_AXIS_WIDTH = 120;

  return (
    <BarChart
      data={rows}
      layout={horizontal ? "vertical" : "horizontal"}
      margin={{
        // Top labels need headroom that the classic axis-bearing layout
        // doesn't reserve.
        top: !horizontal && labels ? 26 : 16,
        right: listMode ? 72 : 24,
        left: 0, bottom: 0,
      }}
      barCategoryGap={horizontal ? style.bar.categoryGap.horizontal : style.bar.categoryGap.vertical}
      onClick={handleClick}
    >
      {SeriesGradients({ prefix: "bar", gid, colors: palette, style, horizontal })}
      {/* Grid lines run across the VALUE axis, which swaps with orientation.
          A ranked list carries its own track per bar instead, and a style with
          grid "none" skips the element entirely. */}
      {!listMode && gridProps && <CartesianGrid {...gridProps} />}
      {horizontal ? (
        <>
          <XAxis type="number" {...AXIS_PROPS} domain={Y_AXIS_DOMAIN} tickFormatter={yTickFormatter} hide={listMode || hideValueAxis} />
          <YAxis
            type="category" dataKey={xField} {...AXIS_PROPS} width={CATEGORY_AXIS_WIDTH}
            tick={{ fill: LABEL_FILL, fontSize: 12, fontWeight: 500 }}
          />
        </>
      ) : (
        <>
          <XAxis dataKey={xField} {...AXIS_PROPS} />
          <YAxis {...AXIS_PROPS} domain={Y_AXIS_DOMAIN} tickFormatter={yTickFormatter} width={Y_AXIS_WIDTH} hide={hideValueAxis} />
        </>
      )}
      <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: CURSOR_FILL }} formatter={tooltipFormatter as any} />
      {/* One series needs no legend — the title already names it. */}
      {(showLegend ?? !isSingleSeries) && <Legend wrapperStyle={LEGEND_STYLE} iconType="circle" iconSize={7} />}
      {renderReferenceLines()}
      {renderAnnotations()}
      {renderForecastDecor()}
      {yFields.map((f, i) => {
        // Per-bar colouring for single-series charts (multi-series already
        // conveys category via series colour, so this is a no-op there):
        //
        //   - Categorical (categoricalColor=true) — each bar takes the next
        //     palette colour by row index, for "X by category" reads where
        //     each bar IS a different thing (region, team, channel).
        //   - Forecast rows — a solid fill in the shared forecast accent (not
        //     a dimmed series colour), so a projected bar reads as a
        //     different KIND of bar, not just a fainter one.
        //   - Otherwise every bar is the series colour via the Bar's fill.
        //
        // Once either applies we render one Cell per row, folding both into
        // the same pass rather than two Cell arrays Recharts would have to
        // reconcile by index.
        const useCategorical = isSingleSeries && categoricalColor === true;
        // Emphasis is per-ROW, so like categoricalColor it only means anything
        // on a single series — with grouped or stacked bars colour is already
        // carrying which series a segment belongs to.
        const useEmphasis = isSingleSeries && typeof emphasisTop === "number" && emphasisTop > 0;
        const hasForecastRows = !!forecast && rows.some((r) => r.__forecast);
        const barFill = seriesFill("bar", gid, i, palette, style);
        // The sunk track behind each bar. An element, not a props object:
        // Recharts strips non-SVG keys (radius) from a plain object before
        // drawing the background.
        const track = showTrack
          ? <Rectangle radius={barRadius} fill="hsl(var(--muted))" />
          : undefined;
        return (
          <Bar
            key={f} dataKey={f} stackId={stacked ? "s" : undefined}
            fill={barFill} radius={barRadius}
            maxBarSize={horizontal ? style.bar.maxBarSize.horizontal : style.bar.maxBarSize.vertical}
            background={track}
            isAnimationActive={!print} animationDuration={600}
          >
            {(useCategorical || hasForecastRows || useEmphasis) && rows.map((row, ri) => {
              const isForecastRow = !!row.__forecast;
              // Priority order, and the reason for it: a projected bar is a
              // different KIND of bar so the forecast accent outranks
              // everything; then de-emphasis, which is the whole point of the
              // setting; then per-category colour for the rows still in scope.
              const fill = isForecastRow
                ? FORECAST_COLOR
                : useEmphasis && ri >= emphasisTop!
                  ? DEEMPHASIS_FILL
                  : useCategorical
                    ? seriesFill("bar", gid, ri, palette, style)
                    : barFill;
              return (
                <Cell
                  key={ri}
                  fill={fill}
                  fillOpacity={isForecastRow ? 0.3 : 1}
                  stroke={isForecastRow ? FORECAST_COLOR : undefined}
                  strokeDasharray={isForecastRow ? "3 3" : undefined}
                />
              );
            })}
            {labels && (
              <LabelList
                dataKey={f}
                position={horizontal ? "right" : "top"}
                offset={horizontal ? 8 : 4}
                fontSize={11}
                fontWeight={500}
                // A label that merely annotates a bar the axis already measures
                // can sit back in muted ink. Once the style has dropped the
                // value axis the label IS the readout, so it takes full ink —
                // the same call the horizontal ranked list already made.
                fill={horizontal || hideValueAxis ? "hsl(var(--foreground))" : LABEL_FILL}
                className="font-mono"
                formatter={(v: any) => formatValue(Number(v), fmt, currency)}
              />
            )}
          </Bar>
        );
      })}
    </BarChart>
  );
}
