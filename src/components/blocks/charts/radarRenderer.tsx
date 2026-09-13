/**
 * Radar (spider) chart — compares multiple series across several dimensions
 * at once. xField is the "spoke" per row (e.g. a metric name); each yField
 * is one entity/series plotted as its own polygon.
 *
 * Deliberately does NOT wire up renderReferenceLines/renderAnnotations/
 * renderForecastDecor: those draw Cartesian <ReferenceLine>/<ReferenceArea>
 * elements anchored to an XAxis/YAxis pair, but Radar has no Cartesian axes
 * at all (PolarGrid/PolarAngleAxis/PolarRadiusAxis instead) — the exact
 * "Could not find yAxis by id" failure mode the combo-chart fix closed
 * would resurface here for a different reason (no Cartesian axis to find,
 * not the wrong one). Treemap/Funnel skip the same three for the same
 * reason. Radar isn't forecast-eligible in ChartBlock.tsx either — a set of
 * dimensions being compared right now has no "next" to project.
 */
import type { ReactElement } from "react";
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Tooltip, Legend,
} from "recharts";
import { TOOLTIP_STYLE, GRID_STROKE, TICK_FILL, LABEL_FILL, LEGEND_STYLE, formatValue, type ChartRenderCtx } from "./shared";

export function renderRadarChart(ctx: ChartRenderCtx): ReactElement {
  const { data, xField, yFields, palette, fmt, currency, print, showLegend } = ctx;
  const radiusTickFormatter = (v: number) => formatValue(v, fmt, currency);
  const tooltipFormatter = (v: any) => [formatValue(Number(v), fmt, currency), ""];
  // Radar is circular, so its size is capped by the SHORTER side of
  // whatever box it's given — and a report chart block is almost always
  // wide-and-short (the same block shape a bar/line chart wants), not
  // square. That's the actual cause of the leftover space: it's the block's
  // aspect ratio, not the chart's own sizing, and no amount of outerRadius
  // tuning changes a container's shape. What DOES help: reclaiming height
  // the Legend was eating from *below* the ring by moving it to the *right*
  // instead — height is the scarce resource here, width is the one this
  // block already has plenty of. (Resizing the block taller in the Layout
  // panel — X/Y/Width/Height — helps far more than either of these; that's
  // a block-shape choice for whoever places it, not something the renderer
  // can decide for them.)
  const hasLegend = showLegend ?? true;
  return (
    <RadarChart
      data={data as any[]}
      margin={{ top: 4, right: hasLegend ? 4 : 8, left: 8, bottom: 4 }}
      cx={hasLegend ? "42%" : "50%"}
      cy="50%"
      outerRadius="88%"
    >
      <PolarGrid stroke={GRID_STROKE} />
      <PolarAngleAxis dataKey={xField} tick={{ fill: LABEL_FILL, fontSize: 10.5, fontWeight: 500 }} />
      <PolarRadiusAxis tick={{ fill: TICK_FILL, fontSize: 9 }} tickFormatter={radiusTickFormatter} axisLine={false} />
      <Tooltip contentStyle={TOOLTIP_STYLE} formatter={tooltipFormatter as any} />
      {hasLegend && (
        <Legend
          layout="vertical"
          align="right"
          verticalAlign="middle"
          wrapperStyle={{ fontSize: 11, color: LEGEND_STYLE.color, right: 0 }}
          iconType="circle"
          iconSize={7}
        />
      )}
      {yFields.map((f, i) => {
        const color = palette[i % palette.length];
        return (
          <Radar
            key={f}
            name={f}
            dataKey={f}
            stroke={color}
            fill={color}
            fillOpacity={0.25}
            strokeWidth={2}
            isAnimationActive={!print}
            animationDuration={700}
          />
        );
      })}
    </RadarChart>
  );
}
