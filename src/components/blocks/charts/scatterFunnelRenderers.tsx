/**
 * Scatter and Funnel chart JSX, extracted verbatim out of ChartBlock.tsx's
 * ~760-line ChartBlockInner render ternary. First step of splitting that
 * component up — deliberately kept as plain functions returning JSX
 * (called inline, e.g. `{renderScatterChart(ctx)}`), NOT as separate React
 * components (`<ScatterChartRenderer ctx={ctx} />`). That distinction
 * matters: a plain function call stays in the parent's own render pass —
 * no new mount/unmount, no new ResponsiveContainer nesting, no re-render
 * timing change — so the only real risk left is prop-threading correctness,
 * which the ChartRenderCtx type below makes a compile error if missed.
 */
import type { ReactElement } from "react";
import {
  CartesianGrid, Legend, Tooltip, XAxis, YAxis, ZAxis,
  ScatterChart, Scatter, FunnelChart, Funnel, LabelList,
} from "recharts";
import { AXIS_PROPS, Y_AXIS_DOMAIN, Y_AXIS_WIDTH, TOOLTIP_STYLE, GRID_STROKE, LEGEND_STYLE, formatValue, type ChartRenderCtx } from "./shared";

/**
 * Custom Funnel name label — draws the channel name CENTERED inside its own
 * segment, instead of Recharts' default `<LabelList position="right">`.
 * That built-in positioning assumes a monotonically narrowing funnel (each
 * row smaller than the last); its computed anchor is only guaranteed clear
 * of the shapes under that assumption. This chart's rows render in query
 * order, not sorted by value (the SQL author controls ordering — see
 * renderFunnelChart below), so an out-of-order row can end up wider than
 * the one above it — the resulting "bowtie" shape put the built-in label
 * off to the side or behind another band, effectively invisible (reported
 * live: "nothing show"). LabelList resolves `dataKey` to `value` and hands
 * each segment's own x/y/width/height to this `content` render prop —
 * using that instead of the built-in position logic keeps the label on its
 * own segment no matter what shape it turns out to be, the same approach
 * TreemapCell already uses one file over. `dyOffset` nudges it up when the
 * value LabelList below is also showing, so the two don't overlap.
 */
function FunnelCenteredLabel(props: any) {
  const { x, y, width, height, value, dyOffset } = props;
  if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number") {
    return null;
  }
  return (
    <text
      x={x + width / 2}
      y={y + height / 2 + dyOffset}
      textAnchor="middle"
      dominantBaseline="middle"
      fill="#ffffff"
      fontSize={11}
      fontWeight={600}
    >
      {String(value ?? "")}
    </text>
  );
}

export function renderScatterChart(ctx: ChartRenderCtx): ReactElement {
  const { data, xField, yFields, cfg, palette, fmt, currency, print, showLegend, handleClick, renderReferenceLines, renderAnnotations, renderForecastDecor } = ctx;
  const yTickFormatter = (v: number) => formatValue(v, fmt, currency);
  const tooltipFormatter = (v: any) => [formatValue(Number(v), fmt, currency), ""];
  // Scatter / bubble. xField = x, yFields[0] = y, optional sizeField
  // drives the bubble size via ZAxis.
  return (
    <ScatterChart margin={{ top: 16, right: 24, left: 0, bottom: 0 }} onClick={handleClick}>
      <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
      <XAxis dataKey={xField} {...AXIS_PROPS} type="number" tickFormatter={yTickFormatter} />
      <YAxis dataKey={yFields[0]} {...AXIS_PROPS} domain={Y_AXIS_DOMAIN} tickFormatter={yTickFormatter} width={Y_AXIS_WIDTH} />
      {cfg.sizeField && (
        <ZAxis dataKey={cfg.sizeField} range={[36, 360]} name={cfg.sizeField} />
      )}
      <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ strokeDasharray: "3 3" }} formatter={tooltipFormatter as any} />
      {(showLegend ?? true) && <Legend wrapperStyle={LEGEND_STYLE} iconType="circle" iconSize={7} />}
      {renderReferenceLines()}
      {renderAnnotations()}
      {renderForecastDecor()}
      <Scatter
        data={data as any[]}
        fill={palette[0]}
        fillOpacity={0.7}
        isAnimationActive={!print}
        animationDuration={700}
      />
    </ScatterChart>
  );
}

export function renderFunnelChart(ctx: ChartRenderCtx): ReactElement {
  const { data, xField, yFields, palette, fmt, currency, print, showDataLabels } = ctx;
  const tooltipFormatter = (v: any) => [formatValue(Number(v), fmt, currency), ""];
  // Funnel. yFields[0] is the stage size; rows render top-to-bottom
  // in the order they arrive (so the SQL author controls ordering).
  return (
    <FunnelChart>
      <Tooltip contentStyle={TOOLTIP_STYLE} formatter={tooltipFormatter as any} />
      <Funnel
        data={(data as any[]).map((d, i) => ({
          ...d,
          fill: palette[i % palette.length],
        }))}
        dataKey={yFields[0]}
        nameKey={xField}
        isAnimationActive={!print}
        animationDuration={700}
      >
        <LabelList dataKey={xField} content={<FunnelCenteredLabel dyOffset={showDataLabels ? -7 : 0} />} />
        {showDataLabels && (
          // compact: false — this label sits inside its own segment, not a
          // 56px axis gutter; a reader looking at one segment's number wants
          // the real figure ("61,000"), not the axis-oriented "61K".
          <LabelList position="center" dy={9} dataKey={yFields[0]} fill="white" fontSize={11}
            formatter={(v: any) => formatValue(Number(v), fmt, currency, { compact: false })} />
        )}
      </Funnel>
    </FunnelChart>
  );
}
