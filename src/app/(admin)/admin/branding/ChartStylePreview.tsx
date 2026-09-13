"use client";
/**
 * A small bar-chart sketch for the chart-style picker, drawn straight from the
 * same ResolvedChartStyle token object the real renderers consume — so the
 * swatch can't drift from the thing it's advertising on the properties it
 * shows (corner radius, gradient vs flat, ghost track, grid, value axis).
 *
 * Hand-drawn SVG rather than a real Recharts chart on purpose: three of these
 * render inside a settings form, and mounting three ResponsiveContainers with
 * their ResizeObservers to draw twelve rectangles is a poor trade. Anything
 * this sketch can't honestly show, it simply doesn't draw.
 */
import type { ResolvedChartStyle } from "@/lib/reporting/chartStyles";

const BARS = [0.95, 0.72, 0.55, 0.38];
const W = 132;
const H = 54;

export function ChartStylePreview({ style, color }: { style: ResolvedChartStyle; color: string }) {
  const gid = `csp-${style.slug}`;
  const plotTop = 4;
  const plotBottom = H - 2;
  const plotH = plotBottom - plotTop;
  // Direct labels replace the axis in the real renderers, so the sketch gives
  // that space back to the plot instead of drawing an axis gutter.
  const left = style.valueAxis ? 16 : 2;
  const slotW = (W - left - 2) / BARS.length;
  const barW = Math.min(slotW * 0.62, 18);
  const r = Math.min(style.bar.radius, barW / 2);

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-hidden className="block">
      {style.fill.gradient && (
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={style.fill.stops[0]} />
            <stop offset="100%" stopColor={color} stopOpacity={style.fill.stops[1]} />
          </linearGradient>
        </defs>
      )}

      {/* The sketch shows a plain vertical bar chart, which is exactly the case
          where a labelling style drops its axis — and with the axis gone the
          grid goes with it (see barRenderer). */}
      {style.grid !== "none" && style.valueAxis && [0.25, 0.5, 0.75].map((f) => (
        <line
          key={f}
          x1={left} x2={W - 2}
          y1={plotTop + plotH * f} y2={plotTop + plotH * f}
          stroke="hsl(var(--border))"
          strokeDasharray={style.grid === "soft" ? "1 5" : "2 4"}
          strokeOpacity={style.grid === "soft" ? 0.85 : 0.7}
        />
      ))}

      {style.valueAxis && [0, 0.5, 1].map((f) => (
        <text
          key={f}
          x={left - 3} y={plotTop + plotH * f + 3}
          textAnchor="end" fontSize={5} fill="hsl(var(--faint))"
        >
          {Math.round((1 - f) * 80)}
        </text>
      ))}

      {BARS.map((v, i) => {
        const x = left + i * slotW + (slotW - barW) / 2;
        const h = plotH * v;
        const y = plotBottom - h;
        return (
          <g key={i}>
            {/* "list" tracks belong to the horizontal ranked layout, which
                this vertical sketch isn't showing — so no style draws one here. */}
            {style.bar.track === "always" && (
              <rect
                x={x} y={plotTop} width={barW} height={plotH}
                rx={r} fill="hsl(var(--muted))"
              />
            )}
            <rect
              x={x} y={y} width={barW} height={h}
              // Only the top corners round on a column, same as the renderer.
              rx={r} ry={r}
              fill={style.fill.gradient ? `url(#${gid})` : color}
            />
            {/* Square off the bottom corners the rx above rounded, so a bar
                sits on the baseline instead of floating on two curves. */}
            {r > 0 && h > r && (
              <rect x={x} y={plotBottom - r} width={barW} height={r}
                fill={style.fill.gradient ? `url(#${gid})` : color} />
            )}
            {style.forceDataLabels && (
              <text
                x={x + barW / 2} y={y - 2}
                textAnchor="middle" fontSize={5} fontWeight={600}
                fill="hsl(var(--foreground))"
              >
                {Math.round(v * 80)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
