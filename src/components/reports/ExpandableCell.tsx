"use client";
/**
 * A report block's grid cell that a reader can enlarge: a button lifts the
 * same cell out of the grid to fill the window, so the chart re-lays itself
 * out at that size (Recharts, the viewBox SVGs and the 3D stage all follow
 * their box) without remounting — a zoomed sunburst or a time-lapse frame
 * stays where the reader left it. Esc, the close button or the backdrop puts
 * it back. Not the browser's Fullscreen API: that is refused inside embeds
 * and on iOS, and this needs to work wherever a report is read.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Maximize2, X } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";

export function ExpandableCell({ style, attrs, children }: {
  /** The cell's grid placement, dropped while expanded. */
  style: CSSProperties;
  attrs: Record<string, string | number>;
  children: ReactNode;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = before; };
  }, [open]);

  return (
    <>
      {open && <div className="fixed inset-0 z-[60] bg-foreground/40" onClick={() => setOpen(false)} aria-hidden />}
      <div
        {...attrs}
        data-expanded={open || undefined}
        role={open ? "dialog" : undefined}
        aria-modal={open || undefined}
        className={open ? "group/cell fixed inset-3 z-[61] rounded-xl bg-card shadow-xl sm:inset-8" : "group/cell relative"}
        // Expanded, the cell keeps nothing of its grid placement; the block
        // inside clips itself, so the close button can sit over the corner.
        style={open ? { minWidth: 0, minHeight: 0, overflow: "visible" } : style}
      >
        {children}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={t(open ? "block.expand.close" : "block.expand.open")}
          aria-label={t(open ? "block.expand.close" : "block.expand.open")}
          className={
            "absolute z-30 flex items-center justify-center border border-border bg-background text-muted-foreground shadow-sm transition-opacity hover:text-foreground focus-visible:opacity-100 "
            // Expanded, the close sits just outside the card's corner, clear of legends and axes.
            + (open ? "-right-3 -top-3 h-7 w-7 rounded-full opacity-100" : "bottom-2 right-2 h-6 w-6 rounded-md opacity-0 group-hover/cell:opacity-100 [@media(hover:none)]:opacity-70")
          }
        >
          {open ? <X className="h-3.5 w-3.5" /> : <Maximize2 className="h-3 w-3" />}
        </button>
      </div>
    </>
  );
}
