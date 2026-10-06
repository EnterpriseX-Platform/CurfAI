/**
 * Line, Area, and Combo chart JSX, extracted verbatim out of ChartBlock.tsx —
 * same pattern as the other files in this directory (plain functions called
 * inline, not separate React components). Grouped together because they
 * share the most Cartesian-axis/gradient-def machinery of any of the chart
 * types, and Combo is literally Bar+Line composed on shared axes.
 */
import { Fragment, type ReactElement } from "react";
import {
  LineChart, Line, AreaChart, Area, ComposedChart, Bar, Cell,
  CartesianGrid, Legend, Tooltip, XAxis, YAxis, LabelList, Brush,
} from "recharts";
import { AXIS_PROPS, Y_AXIS_DOMAIN, Y_AXIS_WIDTH, TOOLTIP_STYLE, GRID_STROKE, LABEL_FILL, CURSOR_FILL, LEGEND_STYLE, DEEMPHASIS_FILL, formatValue, styleOf, gridPropsFor, type ChartRenderCtx, dateTick, dateLabel, seriesName, seriesTooltip } from "./shared";
import { FORECAST_COLOR, buildForecastFields } from "./PredictionOverlay";

/** A Pareto row's ABC class: by the running share before it (A: the first 80%, B: the next 15%, C: the rest). */
export function paretoClass(running: number, share: number): "A" | "B" | "C" {
  const before = running - share;
  return before < 0.8 - 1e-9 ? "A" : before < 0.95 - 1e-9 ? "B" : "C";
}

export function renderLineChart(ctx: ChartRenderCtx): ReactElement {
  const { data, xField, yFields, palette, fmt, currency, print, showLegend, showDataLabels, forecast, handleClick, renderReferenceLines, renderAnnotations, renderForecastDecor } = ctx;

  const numOpts = { locale: ctx.dateStyle?.locale };
  const style = styleOf(ctx);
  const gridProps = gridPropsFor(style);
  const lineCap = style.line.roundCap ? ("round" as const) : ("butt" as const);
  const lineJoin = style.line.roundCap ? ("round" as const) : ("miter" as const);
  const yTickFormatter = (v: number) => formatValue(v, fmt, currency, numOpts);
  const tooltipFormatter = seriesTooltip(ctx);
  // Only the first yField carries projected values (see the forecast gate in
  // ChartBlock.tsx). The predicted-tail split is done ONCE here, on the same
  // array the chart itself renders from — every series and the axis reads
  // off this single array, never a per-series slice/copy (see
  // buildForecastFields's docstring for why that corrupts a categorical
  // x-axis).
  const predictedKey = forecast ? `${yFields[0]}__predicted` : undefined;
  const chartData = forecast ? buildForecastFields(data as any[], yFields[0]) : (data as any[]);
  return (
    <LineChart data={chartData} margin={{ top: 16, right: 24, left: 0, bottom: 0 }} onClick={handleClick}>
      {gridProps && <CartesianGrid {...gridProps} />}
      <XAxis dataKey={xField} {...AXIS_PROPS} tickFormatter={dateTick(ctx)} />
      <YAxis {...AXIS_PROPS} domain={Y_AXIS_DOMAIN} tickFormatter={yTickFormatter} width={Y_AXIS_WIDTH} />
      <Tooltip contentStyle={TOOLTIP_STYLE} formatter={tooltipFormatter as any} labelFormatter={dateLabel(ctx)} />
      {(showLegend ?? true) && <Legend wrapperStyle={LEGEND_STYLE} iconType="circle" iconSize={7} />}
      {renderReferenceLines()}
      {renderAnnotations()}
      {renderForecastDecor()}
      {yFields.map((f, i) => {
        const color = palette[i % palette.length];
        if (forecast && i === 0) {
          return (
            <Fragment key={f}>
              <Line
                type="monotone" dataKey={f} name={seriesName(f, ctx.cfg)}
                stroke={color} strokeWidth={style.line.strokeWidth} strokeLinecap={lineCap} strokeLinejoin={lineJoin}
                dot={style.line.dots ? { r: 3, fill: color, strokeWidth: 0 } : false}
                activeDot={{ r: 5, strokeWidth: 2, stroke: "#ffffff" }}
                isAnimationActive={!print} animationDuration={700} connectNulls={false}
              >
                {showDataLabels && (
                  <LabelList dataKey={f} position="top" fontSize={10} fill={LABEL_FILL} formatter={(v: any) => formatValue(Number(v), fmt, currency, numOpts)} />
                )}
              </Line>
              <Line
                type="monotone" dataKey={predictedKey!} name={`${seriesName(f, ctx.cfg)} (predicted)`}
                stroke={FORECAST_COLOR} strokeWidth={style.line.strokeWidth} strokeLinecap={lineCap} strokeLinejoin={lineJoin} strokeDasharray="5 3" connectNulls={false}
                dot={style.line.dots ? { r: 3, fill: "#ffffff", stroke: FORECAST_COLOR, strokeWidth: 1.5 } : false}
                activeDot={{ r: 5, strokeWidth: 2, stroke: "#ffffff" }}
                isAnimationActive={false} legendType="none"
              />
            </Fragment>
          );
        }
        return (
          <Line
            key={f} type="monotone" dataKey={f} name={seriesName(f, ctx.cfg)}
            stroke={color} strokeWidth={style.line.strokeWidth} strokeLinecap={lineCap} strokeLinejoin={lineJoin}
            dot={style.line.dots ? { r: 3, fill: color, strokeWidth: 0 } : false}
            activeDot={{ r: 5, strokeWidth: 2, stroke: "#ffffff" }}
            isAnimationActive={!print} animationDuration={700}
          >
            {showDataLabels && (
              <LabelList dataKey={f} position="top" fontSize={10} fill={LABEL_FILL} formatter={(v: any) => formatValue(Number(v), fmt, currency, numOpts)} />
            )}
          </Line>
        );
      })}
      {!print && style.showBrush && chartData.length > 8 && (
        <Brush dataKey={xField} height={22} stroke={palette[0]} tickFormatter={dateTick(ctx)}
               travellerWidth={8}
               fill={CURSOR_FILL} />
      )}
    </LineChart>
  );
}

export function renderAreaChart(ctx: ChartRenderCtx): ReactElement {
  const { data, xField, yFields, palette, fmt, currency, print, showLegend, gid, stacked, forecast, handleClick, renderReferenceLines, renderAnnotations, renderForecastDecor } = ctx;

  const numOpts = { locale: ctx.dateStyle?.locale };
  const style = styleOf(ctx);
  const gridProps = gridPropsFor(style);
  const lineCap = style.line.roundCap ? ("round" as const) : ("butt" as const);
  const lineJoin = style.line.roundCap ? ("round" as const) : ("miter" as const);
  const yTickFormatter = (v: number) => formatValue(v, fmt, currency, numOpts);
  const tooltipFormatter = seriesTooltip(ctx);
  const predictedKey = forecast ? `${yFields[0]}__predicted` : undefined;
  const chartData = forecast ? buildForecastFields(data as any[], yFields[0]) : (data as any[]);
  return (
    <AreaChart data={chartData} margin={{ top: 16, right: 24, left: 0, bottom: 0 }} onClick={handleClick}>
      <defs>
        {yFields.map((_, i) => (
          <linearGradient key={i} id={`area-${gid}-${i}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={palette[i % palette.length]} stopOpacity={0.55} />
            {/* Fading to a 0.05 floor keeps a visible baseline band; fading to
                0 lets the plot ground show through completely. */}
            <stop offset="100%" stopColor={palette[i % palette.length]} stopOpacity={style.area.fadeToZero ? 0 : 0.05} />
          </linearGradient>
        ))}
      </defs>
      {gridProps && <CartesianGrid {...gridProps} />}
      <XAxis dataKey={xField} {...AXIS_PROPS} tickFormatter={dateTick(ctx)} />
      <YAxis {...AXIS_PROPS} domain={Y_AXIS_DOMAIN} tickFormatter={yTickFormatter} width={Y_AXIS_WIDTH} />
      <Tooltip contentStyle={TOOLTIP_STYLE} formatter={tooltipFormatter as any} labelFormatter={dateLabel(ctx)} />
      {(showLegend ?? true) && <Legend wrapperStyle={LEGEND_STYLE} iconType="circle" iconSize={7} />}
      {renderReferenceLines()}
      {renderAnnotations()}
      {renderForecastDecor()}
      {yFields.map((f, i) => {
        const color = palette[i % palette.length];
        if (forecast && i === 0) {
          return (
            <Fragment key={f}>
              <Area
                type="monotone" dataKey={f} name={seriesName(f, ctx.cfg)} stackId={stacked ? "s" : undefined}
                stroke={color} strokeWidth={2}
                fill={`url(#area-${gid}-${i})`}
                isAnimationActive={!print} animationDuration={800} connectNulls={false}
              />
              <Area
                type="monotone" dataKey={predictedKey!} name={`${seriesName(f, ctx.cfg)} (predicted)`}
                stackId={stacked ? "s" : undefined} connectNulls={false}
                stroke={FORECAST_COLOR} strokeWidth={2} strokeDasharray="5 3"
                fill={FORECAST_COLOR} fillOpacity={0.15}
                isAnimationActive={false} legendType="none"
              />
            </Fragment>
          );
        }
        return (
          <Area
            key={f} type="monotone" dataKey={f} name={seriesName(f, ctx.cfg)} stackId={stacked ? "s" : undefined}
            stroke={color} strokeWidth={style.area.strokeWidth}
            strokeLinecap={style.area.roundCap ? "round" : "butt"}
            strokeLinejoin={style.area.roundCap ? "round" : "miter"}
            // An area fill implies accumulated volume. A style that treats the
            // series as a rate drops the fill rather than implying a total —
            // except when stacked, where the fill IS the composition.
            fill={style.area.filled || stacked ? `url(#area-${gid}-${i})` : "none"}
            isAnimationActive={!print} animationDuration={800}
          />
        );
      })}
      {/* Brush-to-zoom — drag the strip at the bottom of the
          chart to focus on a date window. Skipped during PDF
          capture (no interaction in print). */}
      {!print && style.showBrush && chartData.length > 8 && (
        <Brush dataKey={xField} height={22} stroke={palette[0]} tickFormatter={dateTick(ctx)}
               travellerWidth={8}
               fill={CURSOR_FILL} />
      )}
    </AreaChart>
  );
}

export function renderComboChart(ctx: ChartRenderCtx): ReactElement {
  const { data, xField, yFields, palette, fmt, currency, print, showLegend, showDataLabels, gid, lineFields, forecast, handleClick, renderReferenceLines, renderAnnotations, renderForecastDecor } = ctx;

  const numOpts = { locale: ctx.dateStyle?.locale };
  const style = styleOf(ctx);
  const gridProps = gridPropsFor(style);
  const lineCap = style.line.roundCap ? ("round" as const) : ("butt" as const);
  const lineJoin = style.line.roundCap ? ("round" as const) : ("miter" as const);
  const yTickFormatter = (v: number) => formatValue(v, fmt, currency, numOpts);
  const tooltipFormatter = seriesTooltip(ctx);
  const predictedKey = forecast ? `${yFields[0]}__predicted` : undefined;
  const chartData = forecast ? buildForecastFields(data as any[], yFields[0]) : (data as any[]);
  // sharedYAxis (a Pareto): the lines read the bars' axis — see ChartConfigSchema.
  const lineAxis = ctx.cfg?.sharedYAxis ? "left" : "right";
  // Pareto classes: bars by A/B/C from the running-share line before them.
  const abcLine = ctx.cfg?.paretoClasses ? lineFields?.[0] : undefined;
  const abc = abcLine && yFields.includes(abcLine) ? { line: abcLine } : null;
  const abcColor = { A: palette[0]!, B: palette[2 % palette.length]!, C: DEEMPHASIS_FILL };
  return (
    <ComposedChart data={chartData} margin={{ top: 16, right: 24, left: 0, bottom: 0 }} onClick={handleClick}>
      <defs>
        {yFields.map((_, i) => (
          <linearGradient key={i} id={`combo-${gid}-${i}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={palette[i % palette.length]} stopOpacity={0.95} />
            <stop offset="100%" stopColor={palette[i % palette.length]} stopOpacity={0.65} />
          </linearGradient>
        ))}
      </defs>
      {gridProps && <CartesianGrid {...gridProps} />}
      <XAxis dataKey={xField} {...AXIS_PROPS} tickFormatter={dateTick(ctx)} />
      <YAxis yAxisId="left"  {...AXIS_PROPS} domain={Y_AXIS_DOMAIN} tickFormatter={yTickFormatter} width={Y_AXIS_WIDTH} />
      <YAxis yAxisId="right" orientation="right" hide={lineAxis === "left"} {...AXIS_PROPS} domain={Y_AXIS_DOMAIN} tickFormatter={yTickFormatter} width={48} />
      <Tooltip contentStyle={TOOLTIP_STYLE} formatter={tooltipFormatter as any} labelFormatter={dateLabel(ctx)} />
      {(showLegend ?? true) && (abc
        ? <Legend wrapperStyle={LEGEND_STYLE} iconSize={7} payload={[
            ...(["A", "B", "C"] as const).map((k) => ({ value: ctx.text?.["abc" + k] ?? k, type: "square" as const, id: k, color: abcColor[k] })),
            { value: seriesName(abc.line, ctx.cfg), type: "line" as const, id: "line", color: palette[(yFields.indexOf(abc.line)) % palette.length] },
          ]} />
        : <Legend wrapperStyle={LEGEND_STYLE} iconType="circle" iconSize={7} />)}
      {/* Combo declares two named axes ("left"/"right") instead of the
          single default (unnamed, id 0) every other chart type has — these
          three shared decorators need an explicit match or Recharts throws
          ("Could not find yAxis by id 0"). The forecast series is always
          yFields[0] (see isForecastSeries below); anchor to whichever axis
          it actually renders on. */}
      {renderReferenceLines("left")}
      {renderAnnotations("left")}
      {renderForecastDecor(lineFields?.includes(yFields[0]) ? lineAxis : "left")}
      {yFields.map((f, i) => {
        const isLine = lineFields?.includes(f);
        const color = palette[i % palette.length];
        // Only the first yField carries projected values (see the forecast
        // gate in ChartBlock.tsx).
        const isForecastSeries = !!forecast && i === 0;
        if (isLine) {
          if (isForecastSeries) {
            return (
              <Fragment key={f}>
                <Line yAxisId={lineAxis} type="monotone" dataKey={f} name={seriesName(f, ctx.cfg)}
                  stroke={color} strokeWidth={style.line.strokeWidth} strokeLinecap={lineCap} strokeLinejoin={lineJoin} connectNulls={false}
                  dot={style.line.dots ? { r: 3, fill: color, strokeWidth: 0 } : false}
                  activeDot={{ r: 5, strokeWidth: 2, stroke: "#ffffff" }}
                  isAnimationActive={!print} animationDuration={700} />
                <Line yAxisId={lineAxis} type="monotone" dataKey={predictedKey!} name={`${seriesName(f, ctx.cfg)} (predicted)`}
                  stroke={FORECAST_COLOR} strokeWidth={style.line.strokeWidth} strokeLinecap={lineCap} strokeLinejoin={lineJoin} strokeDasharray="5 3" connectNulls={false}
                  dot={style.line.dots ? { r: 3, fill: "#ffffff", stroke: FORECAST_COLOR, strokeWidth: 1.5 } : false}
                  activeDot={{ r: 5, strokeWidth: 2, stroke: "#ffffff" }}
                  isAnimationActive={false} legendType="none" />
              </Fragment>
            );
          }
          return (
            <Line key={f} yAxisId={lineAxis} type="monotone" dataKey={f} name={seriesName(f, ctx.cfg)}
              stroke={color} strokeWidth={style.line.strokeWidth} strokeLinecap={lineCap} strokeLinejoin={lineJoin}
              dot={style.line.dots ? { r: 3, fill: color, strokeWidth: 0 } : false}
              activeDot={{ r: 5, strokeWidth: 2, stroke: "#ffffff" }}
              isAnimationActive={!print} animationDuration={700} />
          );
        }
        const hasForecastRows = isForecastSeries && chartData.some((r: any) => r.__forecast);
        return (
          <Bar key={f} yAxisId="left" dataKey={f} name={seriesName(f, ctx.cfg)}
            fill={`url(#combo-${gid}-${i})`}
            radius={[style.bar.comboRadius, style.bar.comboRadius, 0, 0]}
            isAnimationActive={!print} animationDuration={600}>
            {abc && chartData.map((row: any, ri: number) => (
              <Cell key={ri} fill={abcColor[paretoClass(Number(row?.[abc.line]), Number(row?.[f]))]} />
            ))}
            {!abc && hasForecastRows && chartData.map((row: any, ri: number) => {
              const isForecastRow = !!row.__forecast;
              return (
                <Cell key={ri}
                  fill={isForecastRow ? FORECAST_COLOR : `url(#combo-${gid}-${i})`}
                  fillOpacity={isForecastRow ? 0.3 : 1}
                  stroke={isForecastRow ? FORECAST_COLOR : undefined}
                  strokeDasharray={isForecastRow ? "3 3" : undefined}
                />
              );
            })}
            {showDataLabels && (
              <LabelList dataKey={f} position="top" fontSize={10} fill={LABEL_FILL} formatter={(v: any) => formatValue(Number(v), fmt, currency, numOpts)} />
            )}
          </Bar>
        );
      })}
    </ComposedChart>
  );
}
