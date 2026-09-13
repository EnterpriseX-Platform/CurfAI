/**
 * Pie/Donut chart JSX, extracted verbatim out of ChartBlock.tsx — same
 * pattern as the other files in this directory (plain function called
 * inline, not a separate React component).
 */
import type { ReactElement } from "react";
import { PieChart, Pie, Cell, Tooltip, Legend } from "recharts";
import { TOOLTIP_STYLE, LEGEND_STYLE, formatValue, styleOf, DEEMPHASIS_FILL, type ChartRenderCtx } from "./shared";
import { SeriesGradients, seriesFill } from "./gradients";

export function renderPieChart(ctx: ChartRenderCtx): ReactElement {
  const { data, xField, yFields, cfg, palette, fmt, currency, print, showLegend, showDataLabels, isDonut, drillEnabled, onDrill, blockId, gid } = ctx;
  const style = styleOf(ctx);
  // Emphasis: the first N slices carry the palette, the rest recede to grey so
  // the one the title is about is the only thing the eye lands on. A pie is
  // single-series by construction, so there is no multi-series case to gate.
  const emphasisTop = cfg?.emphasisTop as number | undefined;
  const useEmphasis = typeof emphasisTop === "number" && emphasisTop > 0;
  const tooltipFormatter = (v: any) => [formatValue(Number(v), fmt, currency), ""];
  // Recharts' default slice label (`label={{...styleProps}}`) prints the
  // raw numeric value with no formatting at all — e.g. "22906476639"
  // instead of "22.9B". A function returning a string is Recharts' own
  // supported way to customize label text while keeping its default
  // positioning, so route it through the same formatValue() the tooltip
  // already uses instead of a bare style object.
  const sliceLabel = (entry: any) => formatValue(Number(entry?.value) || 0, fmt, currency);
  // Pie / Donut share the same component with different inner radius.
  // Slices are flat palette fills separated by a card-coloured seam — the
  // same rule as bars: colour means a category, never decoration.
  return (
    <PieChart>
      {SeriesGradients({ prefix: "pie", gid, colors: palette, style })}
      <Tooltip contentStyle={TOOLTIP_STYLE} formatter={tooltipFormatter as any} />
      {(showLegend ?? true) && <Legend wrapperStyle={LEGEND_STYLE} iconType="circle" iconSize={7} />}
      <Pie
        data={data as any[]}
        // A plain string dataKey hands Recharts whatever type the query
        // returned (REST/mock sources commonly stringify numerics, e.g.
        // "253500") — Pie sums every slice's value with `+=` to get each
        // percentage, and summing strings concatenates instead of adding,
        // so the total silently becomes NaN and every sector disappears.
        // Coerce inline (same Number(...) || 0 guard sunburstRenderer.tsx
        // already uses) rather than remapping the whole data array.
        dataKey={(d: any) => Number(d?.[yFields[0]]) || 0}
        nameKey={xField}
        outerRadius="78%" innerRadius={isDonut ? style.pie.innerRadius : "0%"}
        paddingAngle={style.pie.paddingAngle}
        // Rounded slice ends only read on a ring. On a full pie every slice
        // converges on the centre point, and a corner radius there rounds the
        // apex away into a visible hole.
        cornerRadius={isDonut ? style.pie.cornerRadius : 0}
        isAnimationActive={!print} animationDuration={700}
        // Donut used to hard-disable labels regardless of showDataLabels —
        // a ring chart needs a value/legend readout even more than a solid
        // pie does, since there's no filled area to eyeball proportions
        // from. Recharts positions the label along the slice's outer edge
        // for both shapes, so the same config works unchanged.
        label={showDataLabels ? sliceLabel : false}
        onClick={(slice: any) => {
          if (drillEnabled) {
            const v = slice?.payload?.[xField] ?? slice?.name;
            if (v !== undefined) onDrill!(blockId!, v);
          }
        }}
      >
        {(data as any[]).map((_, i) => (
          <Cell
            key={i}
            fill={useEmphasis && i >= emphasisTop!
              ? DEEMPHASIS_FILL
              : seriesFill("pie", gid, i, palette, style)}
            stroke="hsl(var(--card))" strokeWidth={2}
          />
        ))}
      </Pie>
    </PieChart>
  );
}
