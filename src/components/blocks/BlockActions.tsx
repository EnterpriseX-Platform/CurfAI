"use client";
/**
 * BlockActions — single ⋯ menu that collapses every block-level affordance
 * into one trigger.
 *
 * Each data block (chart, table, KPI, heatmap, map, pivot) used to render a
 * 4-icon row in its top-right corner: Ask / Comments / Show work / View
 * proof. Across a 10-block report that's 40 icons of visual noise. Authors
 * told us it felt "demo-toy busy" once you stop hovering.
 *
 * The fix here is the Notion / Linear / dot-dot-dot pattern: collapse all 4
 * into a single MoreHorizontal trigger. Click it once → the row of icons
 * unfolds (still small Lucide icons, with labels) and the user clicks the
 * one they want. Each existing component still owns its own popover/drawer,
 * so we don't have to refactor any of them.
 *
 * Why "expand the row" rather than "render menu items": each existing
 * component already uses Radix Popover anchored to its own trigger
 * element. If we tried to render menu items + open the popover from a
 * different anchor, we'd lose the careful positioning each component
 * already has. Keeping the trigger element in the DOM (just hidden until
 * needed) is the path of least surgery.
 *
 * Closes the menu when:
 *   - User clicks ⋯ again
 *   - User clicks outside the row (capture-phase mousedown)
 *   - User clicks one of the inner buttons (the popover opens; the row
 *     auto-closes after a small delay so the popover stays anchored)
 */
import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

export function BlockActions({
  children,
  className,
}: {
  /** The same icon-row content the block used to render — Ask, Comments,
   *  Show work, ProvenanceBadge in whatever combination applies. */
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Click-outside dismissal. We use mousedown (capture) so that clicking
  // INSIDE one of the inner buttons doesn't immediately re-close before
  // the popover/drawer mounts.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (wrapperRef.current.contains(e.target as Node)) return;
      // Ignore clicks inside Radix portals (DropdownMenu, Popover, etc)
      if ((e.target as Element).closest('[data-radix-popper-content-wrapper], [role="menu"], [role="dialog"]')) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open]);

  return (
    <div ref={wrapperRef} className={cn("relative inline-flex items-center gap-0.5", className)}>
      {/* The action row — only mounted when open so the existing
          opacity-0/group-hover styles inside each child component don't
          fight us. The arbitrary-selector `[&_button]:opacity-100` forces
          every descendant button to full opacity, overriding the
          hover-only opacity-0 each existing component carries. */}
      {open && (
        <div
          className="mr-1 inline-flex items-center gap-0.5 rounded-md border border-border bg-popover/95 px-1 py-0.5 shadow-md backdrop-blur [&_button]:opacity-100"
        >
          {children}
        </div>
      )}

      {/* The single trigger — always visible. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={open ? "Close actions" : "Block actions"}
        aria-label={open ? "Close actions" : "Block actions"}
        aria-expanded={open}
        className={cn(
          "no-print inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/60 transition-colors",
          "hover:bg-muted hover:text-foreground",
          open && "bg-muted text-foreground",
        )}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
