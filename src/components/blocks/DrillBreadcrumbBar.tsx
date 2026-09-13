"use client";
import { ChevronRight, ArrowLeft, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/LocaleContext";

/**
 * Whole-dashboard drill breadcrumb — sits above the report content (not a
 * side panel, not a per-chart overlay). Clicking a chart configured with
 * `drillParam` sets that report parameter and re-runs the WHOLE report
 * (see DashboardViewer's openDrill/navigateDrill), so every block re-scopes
 * together; this bar just tracks and lets the reader navigate the resulting
 * stack of drilled values, e.g. "จชต. / ปัตตานี".
 */

export type DrillBreadcrumbStep = { param: string; value: unknown; label: string };

export function DrillBreadcrumbBar({ rootLabel, breadcrumb, loading, onNavigate, onReset }: {
  rootLabel: string;
  breadcrumb: DrillBreadcrumbStep[];
  loading?: boolean;
  /** Jump to a given depth (0 = collapse to root/no drill). */
  onNavigate: (depth: number) => void;
  onReset: () => void;
}) {
  const { t } = useT();
  if (breadcrumb.length === 0) return null;

  return (
    <div className="no-print flex items-center gap-1.5 border-b border-primary/20 bg-primary/5 px-6 py-2 text-sm">
      <Button
        size="icon" variant="ghost" onClick={() => onNavigate(breadcrumb.length - 1)}
        title={t("drillHierarchy.backTooltip")} className="h-6 w-6 shrink-0"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
      </Button>
      <nav className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={() => onNavigate(0)}
          className="rounded-full px-2 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {rootLabel}
        </button>
        {breadcrumb.map((b, i) => (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
            <button
              type="button"
              onClick={() => onNavigate(i + 1)}
              className={"rounded-full px-2 py-0.5 transition-colors hover:bg-accent " +
                (i === breadcrumb.length - 1 ? "font-semibold text-primary" : "text-muted-foreground")}
            >
              {b.label}
            </button>
          </span>
        ))}
      </nav>
      {loading && <span className="text-xs text-muted-foreground">{t("drillHierarchy.loading")}</span>}
      <Button size="sm" variant="ghost" onClick={onReset} className="ml-auto h-6 gap-1 px-2 text-xs text-muted-foreground">
        <X className="h-3 w-3" /> {t("drillHierarchy.exit")}
      </Button>
    </div>
  );
}
