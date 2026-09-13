"use client";
/**
 * Horizontal + vertical rulers for the designer canvas. Shows millimeter ticks
 * (major every 10 mm, labeled every 20 mm; minor every 2 mm) and highlights
 * the selected block's range across both axes for precision print layout.
 *
 * Measurements assume the page is rendered at a known physical width — the
 * caller passes `widthPx` and `pageWidthMm` so we can derive mm-per-pixel.
 */
import { useMemo } from "react";

export function RulerH({
  widthPx,
  pageWidthMm,
  highlightStartMm,
  highlightEndMm,
}: {
  widthPx: number;
  pageWidthMm: number;
  highlightStartMm?: number;
  highlightEndMm?: number;
}) {
  const pxPerMm = widthPx / pageWidthMm;
  const ticks = useMemo(() => buildTicks(pageWidthMm), [pageWidthMm]);

  return (
    <div
      className="relative h-5 select-none overflow-hidden border-b border-border bg-muted/40"
      style={{ width: widthPx }}
      aria-hidden
    >
      {highlightStartMm != null && highlightEndMm != null && (
        <div
          className="absolute inset-y-0 bg-primary/20"
          style={{
            left: highlightStartMm * pxPerMm,
            width: Math.max(1, (highlightEndMm - highlightStartMm) * pxPerMm),
          }}
        />
      )}
      {ticks.map((t) => (
        <div
          key={t.mm}
          className="absolute bottom-0"
          style={{ left: t.mm * pxPerMm }}
        >
          <div
            className={
              t.major
                ? "h-2.5 w-px bg-foreground/60"
                : t.mid
                  ? "h-1.5 w-px bg-foreground/40"
                  : "h-1 w-px bg-foreground/25"
            }
          />
          {t.label && (
            <span
              className="absolute bottom-2 -translate-x-1/2 text-[9px] font-medium tabular-nums text-muted-foreground"
              style={{ left: 0 }}
            >
              {t.label}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export function RulerV({
  heightPx,
  pageHeightMm,
  highlightStartMm,
  highlightEndMm,
}: {
  heightPx: number;
  pageHeightMm: number;
  highlightStartMm?: number;
  highlightEndMm?: number;
}) {
  const pxPerMm = heightPx / pageHeightMm;
  const ticks = useMemo(() => buildTicks(pageHeightMm), [pageHeightMm]);

  return (
    <div
      className="relative w-5 select-none overflow-hidden border-r border-border bg-muted/40"
      style={{ height: heightPx }}
      aria-hidden
    >
      {highlightStartMm != null && highlightEndMm != null && (
        <div
          className="absolute inset-x-0 bg-primary/20"
          style={{
            top: highlightStartMm * pxPerMm,
            height: Math.max(1, (highlightEndMm - highlightStartMm) * pxPerMm),
          }}
        />
      )}
      {ticks.map((t) => (
        <div
          key={t.mm}
          className="absolute right-0"
          style={{ top: t.mm * pxPerMm }}
        >
          <div
            className={
              t.major
                ? "h-px w-2.5 bg-foreground/60"
                : t.mid
                  ? "h-px w-1.5 bg-foreground/40"
                  : "h-px w-1 bg-foreground/25"
            }
          />
          {t.label && (
            <span
              className="absolute right-2 top-1/2 -translate-y-1/2 rotate-180 text-[9px] font-medium tabular-nums text-muted-foreground"
              style={{ writingMode: "vertical-rl" }}
            >
              {t.label}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Tick definitions — major every 10 mm, label every 20 mm, minor every 2 mm. */
function buildTicks(totalMm: number): Array<{ mm: number; major: boolean; mid: boolean; label?: string }> {
  const ticks: Array<{ mm: number; major: boolean; mid: boolean; label?: string }> = [];
  for (let mm = 0; mm <= totalMm; mm += 2) {
    const major = mm % 10 === 0;
    const mid = mm % 5 === 0;
    const label = major && mm % 20 === 0 && mm > 0 ? String(mm) : undefined;
    ticks.push({ mm, major, mid, label });
  }
  return ticks;
}
