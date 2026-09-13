/**
 * Streamgraph — a stacked Area chart with Recharts' native "wiggle" stack
 * offset (the same d3 stackOffsetWiggle algorithm the format is named for)
 * instead of the usual zero-baseline stack. Every yField renders as one
 * flowing band; xField is the time/sequence axis.
 *
 * Deliberately does NOT wire up renderReferenceLines/renderAnnotations/
 * renderForecastDecor (same reasoning as radarRenderer.tsx): a wiggle stack
 * has no fixed zero baseline — the "0" line drifts to minimize total
 * wiggle — so a value-anchored <ReferenceLine>/<ReferenceArea> would land on
 * a y-position that means nothing to the viewer. The Y axis itself is
 * hidden for the same reason: absolute height is a stacking artifact, only
 * relative band thickness carries information here.
 */
import type { ReactElement } from "react";
import { AreaChart, Area, CartesianGrid, Legend, Tooltip, XAxis } from "recharts";
import { AXIS_PROPS, TOOLTIP_STYLE, GRID_STROKE, LEGEND_STYLE, formatValue, type ChartRenderCtx } from "./shared";

export function renderStreamgraphChart(ctx: ChartRenderCtx): ReactElement {
  const { data, xField, yFields, palette, fmt, currency, print, showLegend, handleClick, gid } = ctx;
  const tooltipFormatter = (v: any) => [formatValue(Number(v), fmt, currency), ""];
  return (
    <AreaChart
      data={data as any[]}
      stackOffset="wiggle"
      margin={{ top: 16, right: 24, left: 8, bottom: 0 }}
      onClick={handleClick}
    >
      <CartesianGrid strokeDasharray="2 4" stroke={GRID_STROKE} vertical={false} strokeOpacity={0.4} />
      <XAxis dataKey={xField} {...AXIS_PROPS} />
      <Tooltip contentStyle={TOOLTIP_STYLE} formatter={tooltipFormatter as any} />
      {(showLegend ?? true) && <Legend wrapperStyle={LEGEND_STYLE} iconType="circle" iconSize={7} />}
      {yFields.map((f, i) => {
        const color = palette[i % palette.length];
        return (
          <Area
            key={f}
            type="basis"
            dataKey={f}
            stackId="stream"
            stroke={color}
            strokeWidth={1.5}
            fill={color}
            fillOpacity={0.78}
            isAnimationActive={!print}
            animationDuration={800}
          />
        );
      })}
    </AreaChart>
  );
}
