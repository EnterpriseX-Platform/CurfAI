/**
 * Series gradient <defs>, shared by every renderer that fills a shape.
 *
 * lineAreaComboRenderers.tsx had the only copy of this block; bringing bar,
 * pie, treemap and waterfall up to the same treatment would otherwise have
 * meant four more near-identical <defs> blocks to keep in sync. One component,
 * driven by the resolved chart style's `fill` tokens.
 *
 * Renders nothing when the active style is flat (classic / enterprise), so a
 * flat style costs no extra DOM rather than emitting unused gradient nodes.
 *
 * MUST be called as a plain function — `{SeriesGradients({...})}` — and never
 * mounted as a JSX element. Recharts walks its children and keeps only the
 * element types it recognises plus raw SVG elements; a custom component in that
 * list is silently dropped. Mounted as JSX the defs never render, every
 * `fill="url(#…)"` becomes unresolvable, and the bars paint as nothing at all
 * (verified live — the chart drew its ghost tracks and no bars). Calling it
 * inline hands Recharts the <defs> element itself, which it passes through.
 * This is also why every renderer in this directory is a plain function.
 */
import type { ReactElement } from "react";
import { gradientId } from "./shared";
import type { ResolvedChartStyle } from "@/lib/reporting/chartStyles";

export function SeriesGradients({
  prefix,
  gid,
  colors,
  style,
  horizontal = false,
}: {
  /** Namespace for the gradient ids, e.g. "bar" / "pie" / "tree". */
  prefix: string;
  /** Per-block graphic id — gradient ids are document-global, so this scopes them. */
  gid: string | undefined;
  colors: string[];
  style: ResolvedChartStyle;
  /** Run the ramp left-to-right (horizontal bars) instead of top-to-bottom. */
  horizontal?: boolean;
}): ReactElement | null {
  if (!style.fill.gradient) return null;
  const [from, to] = style.fill.stops;
  return (
    <defs>
      {colors.map((c, i) => (
        <linearGradient
          key={i}
          id={gradientId(prefix, gid, i)}
          x1="0" y1="0"
          x2={horizontal ? "1" : "0"}
          y2={horizontal ? "0" : "1"}
        >
          <stop offset="0%"   stopColor={c} stopOpacity={from} />
          <stop offset="100%" stopColor={c} stopOpacity={to} />
        </linearGradient>
      ))}
    </defs>
  );
}

/**
 * The fill for series `i`: a gradient url under a gradient style, the flat
 * palette colour otherwise. Keeps the ternary out of every call site.
 */
export function seriesFill(
  prefix: string,
  gid: string | undefined,
  i: number,
  colors: string[],
  style: ResolvedChartStyle,
): string {
  // Wrap BEFORE building the id, not just for the flat colour: callers pass a
  // row index under categorical colouring, which routinely runs past the
  // palette length, and an unwrapped id points at a gradient that was never
  // emitted (an unresolvable url(#…) paints the shape black in Chromium).
  const k = ((i % colors.length) + colors.length) % colors.length;
  if (!style.fill.gradient) return colors[k];
  return `url(#${gradientId(prefix, gid, k)})`;
}
