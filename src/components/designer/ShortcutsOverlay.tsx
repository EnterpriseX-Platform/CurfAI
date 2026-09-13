"use client";
import { useEffect } from "react";
import { Keyboard, X } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Designer keyboard-shortcut cheatsheet. Mounted by DesignerShell, opened by
 * the `?` key (or via a button in the toolbar). Pure client-side; doesn't own
 * the actual key handlers — those live in DesignerShell — it just lists them.
 *
 * Update this list whenever a new shortcut is added in DesignerShell so the
 * cheatsheet doesn't drift.
 */

type Shortcut = { keys: string[]; label: string; description: string };

const SECTIONS: { title: string; items: Shortcut[] }[] = [
  {
    title: "Editing",
    items: [
      { keys: ["⌘", "Z"], label: "Undo", description: "Step back through the canvas history" },
      { keys: ["⌘", "⇧", "Z"], label: "Redo", description: "Re-apply an undone change" },
      { keys: ["⌘", "Y"], label: "Redo (alt)", description: "Same as ⌘⇧Z" },
      { keys: ["⌘", "D"], label: "Duplicate block", description: "Copy the selected block below itself" },
      { keys: ["Del"], label: "Delete block", description: "Remove the selected block (also Backspace)" },
      { keys: ["Esc"], label: "Deselect", description: "Clear the current selection" },
    ],
  },
  {
    title: "Run & view",
    items: [
      { keys: ["⌘", "R"], label: "Refresh dataset", description: "Re-run the report's queries against the live DB" },
      { keys: ["?"], label: "Show shortcuts", description: "Open this overlay" },
    ],
  },
  {
    title: "Pointer",
    items: [
      { keys: ["Drag handle"], label: "Move block", description: "Grab the top-left chip to drag — clicking the body just selects" },
      { keys: ["Click body"], label: "Select block", description: "Selection drives the property panel + ruler highlight" },
      { keys: ["Drag corner"], label: "Resize", description: "Snaps to the 12-column grid; mm readout appears on the rulers" },
    ],
  },
];

export function ShortcutsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-[640px] max-w-[92vw] overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div className="flex items-center gap-2">
            <Keyboard className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Keyboard shortcuts</h2>
            <span className="text-[11px] text-muted-foreground">— press <Kbd>Esc</Kbd> to close</span>
          </div>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="grid max-h-[70vh] gap-5 overflow-y-auto p-5">
          {SECTIONS.map((section) => (
            <section key={section.title}>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {section.title}
              </h3>
              <div className="overflow-hidden rounded-md border border-border/60 bg-muted/30">
                {section.items.map((s, i) => (
                  <div
                    key={s.label}
                    className={`grid grid-cols-[150px_1fr] items-center gap-3 px-3 py-2 ${
                      i > 0 ? "border-t border-border/60" : ""
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-1">
                      {s.keys.map((k, idx) => (
                        <span key={idx} className="contents">
                          {idx > 0 && <span className="text-[10px] text-muted-foreground">+</span>}
                          <Kbd>{k}</Kbd>
                        </span>
                      ))}
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-foreground">{s.label}</div>
                      <div className="text-[11px] text-muted-foreground">{s.description}</div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
          <p className="px-1 text-[11px] text-muted-foreground">
            On Windows / Linux, <Kbd>⌘</Kbd> means <Kbd>Ctrl</Kbd>.
          </p>
        </div>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[20px] items-center justify-center rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] font-medium text-foreground shadow-xs">
      {children}
    </kbd>
  );
}
