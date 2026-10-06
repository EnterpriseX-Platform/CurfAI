"use client";
/**
 * Zoom in and out of any chart: the mouse wheel zooms at the pointer — in
 * the Enlarge view, or on the page once the chart is clicked into, or with
 * Ctrl/⌘ (and a trackpad pinch) anywhere; the rule is wheelZoom.ts, shared
 * with the 3D views. The +/− buttons zoom on the middle, a drag pans once
 * zoomed, reset puts it back. Scrolling past a chart nobody clicked still
 * scrolls the page.
 *
 * One wrapper for every chart kind, by CSS transform: hand-drawn SVG charts
 * hit-test natively, and Recharts (2.15) divides its pointer position by the
 * rendered scale, so its tooltips still find the right bar. A drag that pans
 * swallows the click that ends it, so panning never drills into a bar.
 * The PDF and print capture get the chart as it is.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";
import { wheelZooms } from "./wheelZoom";

const MIN = 1;
const MAX = 8;

export function ChartZoom({ children, print, enabled = true, labels }: {
  children: ReactNode;
  print?: boolean;
  /** Off for a chart with nothing to zoom into (a gauge's one number) or its own camera (3D). */
  enabled?: boolean;
  labels: { zoomIn: string; zoomOut: string; reset: string };
}) {
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const swallowClick = useRef(false);
  /** Clicked into: a plain wheel zooms until the pointer leaves (wheelZoom.ts). */
  const activated = useRef(false);

  // Keep the chart covering its box: no panning past an edge, none at all at 1×.
  const clamp = (k: number, x: number, y: number) => {
    const el = host.current;
    const w = el?.clientWidth ?? 0, h = el?.clientHeight ?? 0;
    return { k, x: Math.min(0, Math.max(w - w * k, x)), y: Math.min(0, Math.max(h - h * k, y)) };
  };
  /** Zoom to `k`, keeping the point (px, py) of the box where it is on screen. */
  const zoomAt = (next: number, px: number, py: number) => {
    const { k, x, y } = viewRef.current;
    const k2 = Math.min(MAX, Math.max(MIN, next));
    setView(clamp(k2, px - ((px - x) / k) * k2, py - ((py - y) / k) * k2));
  };

  useEffect(() => {
    const el = host.current;
    if (!el || print || !enabled) return;
    const onWheel = (e: WheelEvent) => {
      if (!wheelZooms(e, el, activated.current)) return;
      // Scrolling down at full size on the page lets the page scroll on.
      if (!e.ctrlKey && !e.metaKey && viewRef.current.k <= 1.001 && e.deltaY > 0 && !el.closest("[data-expanded]")) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(viewRef.current.k * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [print, enabled]);

  if (print || !enabled) return <>{children}</>;
  const zoomed = view.k > 1.001;
  const centre = () => ({ x: (host.current?.clientWidth ?? 0) / 2, y: (host.current?.clientHeight ?? 0) / 2 });

  return (
    <div
      ref={host}
      data-chart-zoom={zoomed ? view.k.toFixed(2) : undefined}
      className="group/zoom relative h-full w-full overflow-hidden"
      style={{ cursor: drag.current?.moved ? "grabbing" : zoomed ? "grab" : undefined, touchAction: zoomed ? "none" : undefined }}
      onPointerDownCapture={() => { activated.current = true; }}
      onPointerLeave={() => { activated.current = false; }}
      onPointerDown={(e) => {
        if (!zoomed || e.button !== 0) return;
        // A mark that handles its own drag (a network node) stops the event first.
        drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < 4) return;
        if (!d.moved) { d.moved = true; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }
        setView(clamp(viewRef.current.k, d.vx + dx, d.vy + dy));
      }}
      onPointerUp={() => { swallowClick.current = !!drag.current?.moved; drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
      onClickCapture={(e) => { if (swallowClick.current) { e.stopPropagation(); e.preventDefault(); swallowClick.current = false; } }}
    >
      <div
        className="h-full w-full"
        style={{ transform: zoomed ? `translate(${view.x}px, ${view.y}px) scale(${view.k})` : undefined, transformOrigin: "0 0" }}
      >
        {children}
      </div>
      <div
        // Top right: bottom left sat on legends (the radial's) and axis labels.
        className={"absolute right-1 top-1 z-20 flex items-center gap-0.5 rounded-md border border-border bg-card/90 p-0.5 shadow-xs transition-opacity "
          + (zoomed ? "opacity-100" : "opacity-0 group-hover/zoom:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-70")}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <ZoomButton label={labels.zoomIn} onClick={() => { const c = centre(); zoomAt(view.k * 1.5, c.x, c.y); }} disabled={view.k >= MAX}><Plus className="h-3 w-3" /></ZoomButton>
        <ZoomButton label={labels.zoomOut} onClick={() => { const c = centre(); zoomAt(view.k / 1.5, c.x, c.y); }} disabled={!zoomed}><Minus className="h-3 w-3" /></ZoomButton>
        {zoomed && (
          <>
            <span className="px-1 font-mono text-[10px] text-muted-foreground">{Math.round(view.k * 100)}%</span>
            <ZoomButton label={labels.reset} onClick={() => setView({ k: 1, x: 0, y: 0 })}><RotateCcw className="h-3 w-3" /></ZoomButton>
          </>
        )}
      </div>
    </div>
  );
}

function ZoomButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
