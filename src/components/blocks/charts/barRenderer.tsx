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
import { AXIS_PROPS, Y_AXIS_DOMAIN, Y_AXIS_WIDTH, TOOLTIP_STYLE, LABEL_FILL, CURSOR_FILL, LEGEND_STYLE, formatValue, styleOf, gridPropsFor, DEEMPHASIS_FILL, type ChartRenderCtx, dateTick, dateLabel, seriesName, categoryAxisProps, clipLabel, seriesTooltip } from "./shared";
import { SeriesGradients, seriesFill } from "./gradients";
import { directLabelsFit } from "@/lib/reporting/chartStyles";
import { FORECAST_COLOR } from "./PredictionOverlay";
import { barsHorizontal } from "./barOrientation";

export function renderBarChart(ctx: ChartRenderCtx): ReactElement {
  const {
    data, xField, yFields, palette, fmt, currency, print, showLegend, showDataLabels,
    stacked, cfg, gid, forecast, handleClick, renderReferenceLines, renderAnnotations, renderForecastDecor,
  } = ctx;
  const numOpts = { locale: ctx.dateStyle?.locale };
  const style = styleOf(ctx);
  const categoricalColor = cfg?.categoricalColor as boolean | undefined;
  const emphasisTop = cfg?.emphasisTop as number | undefined;
  const emphasisLast = cfg?.emphasisLast === true;
  const yTickFormatter = (v: number) => formatValue(v, fmt, currency, numOpts);
  const tooltipFormatter = seriesTooltip(ctx);
  const rows = data as any[];

  // Horizontal bars: Recharts spells this `layout="vertical"` (it describes
  // the axis stack, not the bars), the axes swap roles, and the corner
  // radius runs left-to-right instead of top-down. Unset orientation over
  // more than eight named categories lies down too (barsHorizontal) instead
  // of slanting labels nobody can read; a time axis stays upright.
  const horizontal = barsHorizontal(cfg?.orientation, rows.map((r) => r?.[xField]));
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
  // Both axes always show, data labels or not: a bar chart with its value axis
  // dropped read as unlabelled ("no X and Y"), while the same data switched to a
  // line showed both. Labels on the bars are the readout; the axis keeps the scale.
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
  const gridProps = gridPropsFor(style, { vertical: horizontal, horizontal: !horizontal });
  // Category labels need real room when they run down the side.
  const CATEGORY_AXIS_WIDTH = 150;

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
      // A stacked loss (churn beside new sales) stacks below zero, not on top of the gains; all-positive stacks are unchanged.
      stackOffset={stacked ? "sign" : undefined}
      onClick={handleClick}
    >
      {SeriesGradients({ prefix: "bar", gid, colors: palette, style, horizontal })}
      {/* Grid lines run across the VALUE axis, which swaps with orientation.
          A ranked list carries its own track per bar instead, and a style with
          grid "none" skips the element entirely. */}
      {!listMode && gridProps && <CartesianGrid {...gridProps} />}
      {/* Each axis is a direct child of the chart, never inside a fragment: Recharts finds its axes by
          scanning children, and the react-is it uses (18) does not recognise a fragment made by the React 19
          that Next's app router runs, so axes wrapped in <>...</> were silently dropped in the browser (a
          bar chart with no X and no Y) while server-rendered tests still saw them. */}
      {horizontal && <XAxis type="number" {...AXIS_PROPS} domain={Y_AXIS_DOMAIN} tickFormatter={yTickFormatter} />}
      {horizontal && (
        <YAxis
          // every bar named: Recharts otherwise drops alternate names it guesses would collide
          type="category" dataKey={xField} {...AXIS_PROPS} width={CATEGORY_AXIS_WIDTH} interval={0}
          tick={(props: any) => <CategoryTick {...props} maxWidth={CATEGORY_AXIS_WIDTH - 8} />}
        />
      )}
      {!horizontal && <XAxis dataKey={xField} {...AXIS_PROPS} {...categoryAxisProps(rows.length)} tickFormatter={rows.length > 6 ? (v: any) => clipLabel(String(dateTick(ctx)(v) ?? v)) : dateTick(ctx)} />}
      {!horizontal && <YAxis {...AXIS_PROPS} domain={Y_AXIS_DOMAIN} tickFormatter={yTickFormatter} width={Y_AXIS_WIDTH} />}
      <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: CURSOR_FILL }} formatter={tooltipFormatter as any} labelFormatter={dateLabel(ctx)} />
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
        const useLast = isSingleSeries && !useEmphasis && emphasisLast;
        const hasForecastRows = !!forecast && rows.some((r) => r.__forecast);
        // The still-running last period (ctx.partial): same bar, lighter, dashed outline.
        const partialIdx = ctx.partial?.index;
        const seriesColor = palette[i % palette.length];
        const barFill = seriesFill("bar", gid, i, palette, style);
        // The sunk track behind each bar. An element, not a props object:
        // Recharts strips non-SVG keys (radius) from a plain object before
        // drawing the background.
        const track = showTrack
          ? <Rectangle radius={barRadius} fill="hsl(var(--muted))" />
          : undefined;
        return (
          <Bar
            key={f} dataKey={f} name={seriesName(f, ctx.cfg)} stackId={stacked ? "s" : undefined}
            fill={barFill} radius={barRadius}
            maxBarSize={horizontal ? style.bar.maxBarSize.horizontal : style.bar.maxBarSize.vertical}
            background={track}
            isAnimationActive={!print} animationDuration={600}
          >
            {(useCategorical || hasForecastRows || useEmphasis || useLast || partialIdx != null) && rows.map((row, ri) => {
              const isForecastRow = !!row.__forecast;
              const isPartialRow = ri === partialIdx && !isForecastRow;
              // Priority order, and the reason for it: a projected bar is a
              // different KIND of bar so the forecast accent outranks
              // everything; then de-emphasis, which is the whole point of the
              // setting; then per-category colour for the rows still in scope.
              const fill = isForecastRow
                ? FORECAST_COLOR
                : (useEmphasis && ri >= emphasisTop!) || (useLast && ri < rows.length - 1)
                  ? DEEMPHASIS_FILL
                  : useCategorical
                    ? seriesFill("bar", gid, ri, palette, style)
                    : barFill;
              return (
                <Cell
                  key={ri}
                  fill={fill}
                  fillOpacity={isForecastRow ? 0.3 : isPartialRow ? 0.4 : 1}
                  stroke={isForecastRow ? FORECAST_COLOR : isPartialRow ? seriesColor : undefined}
                  strokeDasharray={isForecastRow || isPartialRow ? "3 3" : undefined}
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
                fill={horizontal ? "hsl(var(--foreground))" : LABEL_FILL}
                className="font-mono"
                formatter={(v: any) => formatValue(Number(v), fmt, currency, numOpts)}
              />
            )}
          </Bar>
        );
      })}
    </BarChart>
  );
}

/** Per-character width at the tick's 12px, generous enough for Thai and CJK. */
const TICK_CHAR_PX = 7;
const graphemes = (s: string): string[] => {
  const Seg = (Intl as any).Segmenter;
  return Seg ? Array.from(new Seg(undefined, { granularity: "grapheme" }).segment(s), (g: any) => g.segment as string) : Array.from(s);
};

/**
 * A category name down the side of a horizontal bar, on one line: a long
 * name used to wrap onto a second line that ran into the next bar's label,
 * so a ranking of product names couldn't be read at all. Cut to the axis
 * width with an ellipsis (by grapheme, so a Thai vowel stays on its
 * consonant); the whole name is in the hover title and the tooltip.
 */
function CategoryTick({ x, y, payload, maxWidth }: { x: number; y: number; payload?: { value?: unknown }; maxWidth: number }) {
  const label = String(payload?.value ?? "");
  const room = Math.max(4, Math.floor(maxWidth / TICK_CHAR_PX));
  const parts = graphemes(label);
  const text = parts.length > room ? parts.slice(0, room - 1).join("") + "…" : label;
  return (
    <text x={x} y={y} dy={4} textAnchor="end" fill={LABEL_FILL} fontSize={12} fontWeight={500}>
      <title>{label}</title>
      {text}
    </text>
  );
}
