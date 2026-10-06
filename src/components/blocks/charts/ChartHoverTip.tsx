"use client";
/**
 * The hover tooltip for hand-drawn SVG charts (Sankey, sunburst, box plot,
 * radial, parallel axes, network, chord, the maps and heatmaps). Each mark
 * carries its text in a child `<desc class="chart-tip">` — not a `<title>`,
 * whose native tooltip appears after a second's delay, or never in an
 * embedded view, so a reader hovering a province saw nothing. This shows the
 * nearest mark's text at once, beside the pointer, in the app's own style.
 * Recharts charts keep their own tooltips; they carry no chart-tip, so this
 * stays out of their way.
 */
import { useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";

export function ChartHoverTip({ children, className }: { children: ReactNode; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ text: string; x: number; y: number; w: number; h: number } | null>(null);

  const onMove = (e: ReactPointerEvent) => {
    const root = host.current;
    if (!root) return;
    let el = e.target as Element | null;
    while (el && el !== root) {
      const desc = el.querySelector?.(":scope > desc.chart-tip");
      if (desc?.textContent) {
        const r = root.getBoundingClientRect();
        setTip({ text: desc.textContent, x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height });
        return;
      }
      el = el.parentElement;
    }
    setTip(null);
  };

  // Beside the pointer, flipped to the other side near the right or bottom edge.
  const style = tip ? {
    left: tip.x > tip.w - 200 ? undefined : tip.x + 14,
    right: tip.x > tip.w - 200 ? tip.w - tip.x + 14 : undefined,
    top: tip.y > tip.h - 90 ? undefined : tip.y + 14,
    bottom: tip.y > tip.h - 90 ? tip.h - tip.y + 14 : undefined,
  } : undefined;

  return (
    <div ref={host} className={`relative ${className ?? "h-full w-full"}`} onPointerMove={onMove} onPointerLeave={() => setTip(null)}>
      {children}
      {tip && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-30 max-w-xs whitespace-pre-line rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11px] leading-snug text-popover-foreground shadow-md"
          style={style}
        >
          {tip.text}
        </div>
      )}
    </div>
  );
}
