"use client";
import { Plus, X } from "lucide-react";
import { useDesignerStore } from "@/lib/reporting/store";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/LocaleContext";

/**
 * The report's pages and "Add page", inline in the designer's page-setup
 * row (DesignerShell) rather than a bar of their own. A single-page report
 * shows only the "Add page" button.
 */
export function PageTabs() {
  const { t } = useT();
  const report = useDesignerStore((s) => s.report);
  const activePageId = useDesignerStore((s) => s.activePageId);
  const setActivePage = useDesignerStore((s) => s.setActivePage);
  const addPage = useDesignerStore((s) => s.addPage);
  const removePage = useDesignerStore((s) => s.removePage);

  return (
    <div className="flex min-w-0 items-center gap-1">
      {report.pages.length > 1 && (
        <div role="tablist" aria-label={t("designer.pageSetup.pages")} className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {report.pages.map((p, i) => {
            const active = p.id === activePageId;
            const pageName = t("pageTabs.page").replace("{n}", String(i + 1));
            return (
              <div
                key={p.id}
                className={`group flex items-center gap-1 rounded-md px-2 py-1 text-2xs font-medium transition-colors ${
                  active
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActivePage(p.id)}
                  className="whitespace-nowrap"
                >
                  {pageName}
                  <span className="ml-1 font-normal text-muted-foreground/70">
                    {p.size} · {t(p.orientation === "landscape" ? "designerShell.landscape" : "designerShell.portrait")}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (confirm(t("pageTabs.deleteConfirm").replace("{n}", String(i + 1)))) {
                      removePage(p.id);
                    }
                  }}
                  title={t("pageTabs.deletePage")}
                  aria-label={`${t("pageTabs.deletePage")}: ${pageName}`}
                  className="rounded px-0.5 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}
      <Button size="sm" variant="ghost" onClick={addPage} className="h-7 shrink-0 px-2 text-2xs">
        <Plus className="mr-1 h-3 w-3" /> {t("pageTabs.addPage")}
      </Button>
    </div>
  );
}
