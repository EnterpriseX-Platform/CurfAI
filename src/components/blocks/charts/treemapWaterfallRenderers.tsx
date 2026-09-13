/**
 * Treemap and Waterfall chart JSX, extracted verbatim out of ChartBlock.tsx —
 * same pattern as scatterFunnelRenderers.tsx (see that file's header comment
 * for why these are plain functions called inline, not separate React
 * components: no new mount/unmount, no new ResponsiveContainer nesting).
 */
import type { ReactElement } from "react";
import {
  Bar, BarChart, Cell, CartesianGrid, Customized, Tooltip, XAxis, YAxis, LabelList, Treemap,
} from "recharts";
import { buildWaterfall } from "./Gauge";
import { AXIS_PROPS, Y_AXIS_DOMAIN, Y_AXIS_WIDTH, TOOLTIP_STYLE, LABEL_FILL, DEFAULT_PALETTE, formatValue, styleOf, gridPropsFor, type ChartRenderCtx } from "./shared";
import { SeriesGradients, seriesFill } from "./gradients";
import { CHART_STYLE_PRESETS } from "@/lib/reporting/chartStyles";
import { accentInk } from "@/lib/reporting/accent";

/** Custom Treemap cell — draws the rect + a name/value label pair when the rect is big enough. */
function TreemapCell(props: any) {
  const { x, y, width, height, index, payload, xField, valueField, fmt, currency, palette = DEFAULT_PALETTE, style = CHART_STYLE_PRESETS.classic } = props;
  const fill = payload?.__fill ?? palette[(index ?? 0) % palette.length];
  const name = payload?.[xField] ?? "";
  const rawValue = payload?.[valueField];
  const showName = width > 60 && height > 30;
  const showValue = width > 60 && height > 50;
  // Label ink is chosen from the cell's own flat colour rather than hardcoded
  // white. Custom tenant palettes are arbitrary, and a monochrome style paints
  // EVERY cell from palette[0] — so one pale brand colour used to mean the
  // whole treemap rendered white-on-pale. accentInk is the same luma call the
  // app bar makes, reused rather than re-derived (see its docstring).
  const ink = accentInk(payload?.__flat ?? (typeof fill === "string" && fill.startsWith("#") ? fill : palette[0]));
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={fill} stroke="hsl(var(--card))" strokeWidth={style.treemap.strokeWidth} rx={style.treemap.rx} />
      {showName && (
        <text x={x + 8} y={y + 18} fill={ink.fg} fontSize={11} fontWeight={500}>
          {String(name).slice(0, Math.floor((width - 16) / 7))}
        </text>
      )}
      {showValue && rawValue != null && (
        <text x={x + 8} y={y + 36} fill={ink.soft} fontSize={11}>
          {formatValue(Number(rawValue), fmt, currency)}
        </text>
      )}
    </g>
  );
}

export function renderTreemapChart(ctx: ChartRenderCtx): ReactElement {
  const { data, xField, yFields, palette, fmt, currency, print, gid } = ctx;
  const style = styleOf(ctx);
  const tooltipFormatter = (v: any) => [formatValue(Number(v), fmt, currency), ""];
  // Treemap. yFields[0] = size, optional cfg.colorField = color basis.
  // We pre-bake fills onto the data so each cell can use the palette
  // (Recharts' built-in coloring is uninteresting and uniform). The size
  // field is coerced to a number here too — same reasoning as pieRenderer's
  // dataKey fix: Treemap sums every cell's value to lay out proportional
  // rectangles, and a stringified numeric ("253500", common from REST/mock
  // sources) turns that sum into string concatenation, NaN-ing every cell.
  return (
    <Treemap
      data={(data as any[]).map((d, i) => ({
        ...d,
        [yFields[0]]: Number(d?.[yFields[0]]) || 0,
        // Monochrome styles paint every cell from palette[0]: index-based
        // colour on a treemap encodes nothing (area already carries
        // magnitude), so cycling the palette spends a channel on decoration.
        __fill: seriesFill("tree", gid, style.treemap.monochrome ? 0 : i, palette, style),
        // The flat colour behind __fill — under a gradient style __fill is a
        // url(#…) the ink calculation can't read a luma from.
        __flat: palette[(style.treemap.monochrome ? 0 : i) % palette.length],
      }))}
      dataKey={yFields[0]}
      nameKey={xField}
      stroke="hsl(var(--card))"
      isAnimationActive={!print}
      animationDuration={700}
      content={<TreemapCell xField={xField} valueField={yFields[0]} fmt={fmt} currency={currency} palette={palette} style={style} />}
    >
      {SeriesGradients({ prefix: "tree", gid, colors: palette, style })}
      <Tooltip contentStyle={TOOLTIP_STYLE} formatter={tooltipFormatter as any} />
    </Treemap>
  );
}

/**
 * Dashed step connectors, drawn from the chart's own axis scales so they land
 * on the real bar edges at the real running total. Rendered through
 * <Customized/>, which is the supported way to reach the resolved scales.
 *
 * Guarded end to end: `xAxisMap`/`yAxisMap` are internals Recharts doesn't
 * contract, so a shape change degrades to no connectors rather than a chart
 * that throws.
 */
function waterfallConnectors(wf: any[], xField: string, barWidth: number) {
  return function Connectors(props: any) {
    try {
      const xMap = props?.xAxisMap ?? {};
      const yMap = props?.yAxisMap ?? {};
      const xs = xMap[Object.keys(xMap)[0]]?.scale;
      const ys = yMap[Object.keys(yMap)[0]]?.scale;
      if (!xs || !ys || typeof xs.bandwidth !== "function") return null;
      const bw = xs.bandwidth();
      if (!bw) return null;
      const half = Math.min(barWidth, bw) / 2;
      const segs: ReactElement[] = [];
      for (let i = 0; i < wf.length - 1; i++) {
        const row = wf[i];
        // Running total once this step has been applied — see buildWaterfall:
        // a total draws from zero to __bar, a rise ends at __base + __bar, and
        // a fall has already had its delta folded into __base.
        const level = row.__kind === "total"
          ? row.__bar
          : row.__delta >= 0 ? row.__base + row.__bar : row.__base;
        const y = ys(level);
        const x0 = xs(String(row?.[xField] ?? ""));
        const x1 = xs(String(wf[i + 1]?.[xField] ?? ""));
        if (![y, x0, x1].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
        segs.push(
          <line
            key={i}
            x1={x0 + bw / 2 + half} y1={y}
            x2={x1 + bw / 2 - half} y2={y}
            stroke="hsl(var(--border))" strokeWidth={1} strokeDasharray="3 3"
          />,
        );
      }
      return <g>{segs}</g>;
    } catch { return null; }
  };
}

export function renderWaterfallChart(ctx: ChartRenderCtx): ReactElement {
  const { data, xField, yFields, palette, fmt, currency, print, showDataLabels, renderReferenceLines, renderAnnotations, renderForecastDecor } = ctx;
  const style = styleOf(ctx);
  const yTickFormatter = (v: number) => formatValue(v, fmt, currency);
  // Waterfall — uses BarChart with two stacked bars per row:
  // a hidden "base" spacer + a visible "delta" bar. Total rows
  // (xField === "Total" or last row treated as total) draw from
  // zero in a distinct accent color.
  const wf = buildWaterfall(data as any[], xField, yFields[0]);
  const barSize = style.bar.maxBarSize.vertical;
  // Every step carries its own number under a labelling style, so the value
  // axis becomes redundant — but only once the labels are actually on.
  const labels = showDataLabels ?? style.forceDataLabels;
  const hideValueAxis = !style.valueAxis && labels;
  // No axis to read against means the grid has nothing left to do (same
  // reasoning as barRenderer).
  const gridProps = hideValueAxis ? null : gridPropsFor(style);
  const r = style.bar.radius;
  return (
    <BarChart data={wf} margin={{ top: labels ? 26 : 16, right: 24, left: 0, bottom: 0 }}>
      {gridProps && <CartesianGrid {...gridProps} />}
      <XAxis dataKey={xField} {...AXIS_PROPS} />
      <YAxis {...AXIS_PROPS} domain={Y_AXIS_DOMAIN} tickFormatter={yTickFormatter} width={Y_AXIS_WIDTH} hide={hideValueAxis} />
      {style.waterfall.connectors && (
        <Customized component={waterfallConnectors(wf, xField, barSize)} />
      )}
      <Tooltip
        contentStyle={TOOLTIP_STYLE}
        formatter={(v: any, name: string, p: any) => {
          if (name === "__base") return [null, null] as any;
          const raw = p?.payload?.__delta;
          return [formatValue(Number(raw), fmt, currency), p?.payload?.__kind ?? ""];
        }}
      />
      {renderReferenceLines()}
      {renderAnnotations()}
      {renderForecastDecor()}
      <Bar dataKey="__base" stackId="w" fill="transparent" />
      <Bar dataKey="__bar" stackId="w" radius={[r, r, 0, 0]} maxBarSize={barSize}
        isAnimationActive={!print} animationDuration={600}>
        {wf.map((row, i) => (
          <Cell key={i} fill={
            row.__kind === "total" ? palette[0] :
            row.__delta >= 0 ? "hsl(var(--success))" : "hsl(var(--destructive))"
          } />
        ))}
        {labels && (
          <LabelList
            dataKey="__delta" position="top"
            // Matched to barRenderer's own labels rather than kept at its old
            // 10px muted setting — a waterfall sits beside bar charts on the
            // same page, and its step values carry the scale once the axis is
            // gone, exactly as they do there.
            fontSize={11} fontWeight={500} className="font-mono"
            fill={hideValueAxis ? "hsl(var(--foreground))" : LABEL_FILL}
            formatter={(v: any) => {
              const n = Number(v);
              const text = formatValue(Math.abs(n), fmt, currency);
              // A bridge chart reads as movements, not levels: signing each
              // step says which way it went without needing the axis. Totals
              // are levels, so they stay unsigned.
              if (!style.waterfall.signedLabels || n === 0) return text;
              return (n > 0 ? "+" : "−") + text;
            }}
          />
        )}
      </Bar>
    </BarChart>
  );
}
