"use client";
import { Plus, X } from "lucide-react";
import { useDesignerStore } from "@/lib/reporting/store";
import { Button } from "@/components/ui/button";

export function PageTabs() {
  const report = useDesignerStore((s) => s.report);
  const activePageId = useDesignerStore((s) => s.activePageId);
  const setActivePage = useDesignerStore((s) => s.setActivePage);
  const addPage = useDesignerStore((s) => s.addPage);
  const removePage = useDesignerStore((s) => s.removePage);

  if (report.pages.length <= 1) {
    // Minimal version for single-page reports — just an "Add page" affordance.
    return (
      <div className="flex items-center gap-2 border-b border-border bg-muted/20 px-4 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Page 1 of 1
        </span>
        <Button size="sm" variant="ghost" onClick={addPage} className="h-6 px-2 text-[11px]">
          <Plus className="mr-1 h-3 w-3" /> Add page
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 border-b border-border bg-muted/20 px-4 py-1.5">
      <div className="flex flex-1 items-center gap-1 overflow-x-auto">
        {report.pages.map((p, i) => {
          const active = p.id === activePageId;
          return (
            <div
              key={p.id}
              className={`group flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                active
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <button
                type="button"
                onClick={() => setActivePage(p.id)}
                className="whitespace-nowrap"
              >
                Page {i + 1}
                <span className="ml-1 font-normal text-muted-foreground/70">
                  {p.size} · {p.orientation}
                </span>
              </button>
              {report.pages.length > 1 && (
                <button
                  type="button"
                  onClick={() => {
                    if (confirm(`Delete Page ${i + 1}? Blocks on it will be lost.`)) {
                      removePage(p.id);
                    }
                  }}
                  title="Delete page"
                  className="rounded px-0.5 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <Button size="sm" variant="ghost" onClick={addPage} className="h-6 px-2 text-[11px]">
        <Plus className="mr-1 h-3 w-3" /> Add page
      </Button>
    </div>
  );
}
