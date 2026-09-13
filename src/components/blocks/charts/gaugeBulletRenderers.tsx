/**
 * Gauge and Bullet chart JSX, extracted verbatim out of ChartBlock.tsx —
 * same pattern as the other files in this directory (plain functions called
 * inline, not separate React components). These two are rendered OUTSIDE
 * the ResponsiveContainer/recharts wrapper in ChartBlockInner — GaugeChart
 * and BulletChart are hand-drawn SVG, not recharts primitives — so they
 * don't need the axis/tooltip/legend machinery the other renderers share.
 */
import type { ReactElement } from "react";
import { GaugeChart, BulletChart, computeGaugeBounds } from "./Gauge";
import { formatValue, type ChartRenderCtx } from "./shared";

// Last-resort fallback if a caller ever omits ctx.semantic — ChartBlock.tsx
// always passes theme.semantic today, so this should never actually be hit.
const FALLBACK_SEMANTIC: Record<string, string> = {
  success: "#0E7C5B", warning: "#A8690F", danger: "#B4304A", info: "#3B37D1", neutral: "#8A90A3",
};

export function renderGaugeChart(ctx: ChartRenderCtx): ReactElement {
  const { data, yFields, cfg, palette, fmt, currency, semantic = FALLBACK_SEMANTIC } = ctx;
  // Gauge — pure SVG, value comes from the first row's first yField.
  const v = Number((data[0] as any)?.[yFields[0]]);
  const inferred = computeGaugeBounds(data, yFields[0], cfg);
  return (
    <GaugeChart
      value={v}
      min={inferred.min}
      max={inferred.max}
      target={cfg.gaugeTarget}
      zones={cfg.gaugeZones}
      palette={palette}
      format={(n: number) => formatValue(n, fmt, currency)}
      semantic={semantic}
    />
  );
}

export function renderBulletChart(ctx: ChartRenderCtx): ReactElement {
  const { data, yFields, cfg, palette, fmt, currency, semantic = FALLBACK_SEMANTIC } = ctx;
  const v = Number((data[0] as any)?.[yFields[0]]);
  const inferred = computeGaugeBounds(data, yFields[0], cfg);
  return (
    <BulletChart
      value={v}
      min={inferred.min}
      max={inferred.max}
      target={cfg.gaugeTarget}
      zones={cfg.gaugeZones}
      palette={palette}
      format={(n: number) => formatValue(n, fmt, currency)}
      label={cfg.subtitle}
      semantic={semantic}
    />
  );
}
