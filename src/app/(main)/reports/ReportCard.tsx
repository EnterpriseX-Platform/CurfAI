"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Clock, Pencil, ExternalLink, MoreVertical, Trash2, LayoutGrid, Table2, Shield } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { DeleteReportDialog } from "./DeleteReportDialog";
import { ReportThumbnail } from "@/components/lists/ReportThumbnail";
import type { ThumbModel } from "@/components/lists/thumbnailModel";

export type ReportCardData = {
  id: string;
  /** A report opens in the viewer; a dashboard in its own rotation viewer. */
  kind: "report" | "dashboard";
  href: string;
  editHref: string;
  name: string;
  category: string | null;
  updatedAgo: string;
  /** ISO time of the last change, for sorting. */
  updatedAt: string;
  /** Reports are versioned, dashboards are not. */
  version: number | null;
  ownerInitials: string;
  ownerName: string;
  /** Relative time of the last recorded run, or null when it never ran. */
  lastRun: string | null;
  /** ok = ran in the last 24h · warn = older · crit = last run failed · none = never ran */
  freshness: "ok" | "warn" | "crit" | "none";
  schedules: number;
  blocks: number;
  /** Reports only; a dashboard has no draft state. */
  published: boolean | null;
  /** Who can see it, when that is narrower than the whole workspace. */
  audience: string | null;
  /** Miniature of the first page, drawn from the definition (components/lists/thumbnailModel.ts). */
  shape: ThumbModel;
  /** Localised copy, resolved on the server so the card stays a pure renderer. */
  labels: { lastRun: string; neverRun: string; blocks: string; scheduled: string; by: string; published: string; draft: string; report: string; dashboard: string };
};

const DOT: Record<ReportCardData["freshness"], string> = {
  ok: "bg-success", warn: "bg-warning", crit: "bg-destructive", none: "bg-faint",
};

export function ReportCard({ r, isAdmin }: { r: ReportCardData; isAdmin: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const TypeIcon = r.kind === "dashboard" ? LayoutGrid : Table2;

  return (
    <>
      <div className="group relative">
        {/* Whole-card link: Open the report or dashboard */}
        <Link
          href={r.href}
          className="flex flex-col overflow-hidden rounded-xl border border-border bg-card transition-all hover:-translate-y-px hover:border-input hover:shadow-md"
        >
          <ReportThumbnail model={r.shape} className="h-[148px] border-b border-border" />

          <div className="flex flex-col gap-2.5 px-3.5 py-3">
            <div className="flex items-start justify-between gap-2">
              <h3 className="truncate text-sm font-semibold tracking-tight" title={r.name}>{r.name}</h3>
              {r.version != null && (
                <span className="shrink-0 rounded-sm border border-border px-1.5 py-px font-mono text-2xs text-faint">v{r.version}</span>
              )}
            </div>
            {/* Tags: state (reports only), the type, who can see it when that
                is narrower than the workspace, then the category. */}
            <div className="flex flex-wrap items-center gap-1.5 text-2xs">
              {r.published != null && (
                <span className={cn("inline-flex h-5 items-center rounded-full px-2 font-medium", r.published ? "bg-success/10 text-success" : "bg-muted text-muted-foreground")}>
                  {r.published ? r.labels.published : r.labels.draft}
                </span>
              )}
              <span className="inline-flex h-5 items-center gap-1 rounded-full bg-primary-soft px-2 font-medium text-primary-ink">
                <TypeIcon className="h-3 w-3" /> {r.kind === "dashboard" ? r.labels.dashboard : r.labels.report}
              </span>
              {r.audience && (
                <span className="inline-flex h-5 items-center gap-1 rounded-full border border-border px-2 text-muted-foreground">
                  <Shield className="h-3 w-3" /> {r.audience}
                </span>
              )}
              {r.category && <span className="inline-flex h-5 items-center rounded-full border border-border px-2 text-muted-foreground">{r.category}</span>}
            </div>
            {/* Footer: who and when on one line, the run's facts on a second,
                so the rows stay the same height from card to card. */}
            <div className="flex flex-col gap-1.5 border-t border-border pt-2.5 text-xs text-faint">
              <div className="flex items-center gap-2">
                <span
                  className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-primary-soft font-sans text-2xs font-semibold text-primary-ink"
                  title={r.ownerName}
                >
                  {r.ownerInitials}
                </span>
                <span className="min-w-0 truncate">{r.labels.by} {r.ownerName} · {r.updatedAgo}</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-2xs">
                {r.kind === "report" && (
                  <span className={cn("inline-flex items-center gap-1.5", r.freshness === "crit" && "text-destructive", r.freshness === "warn" && "text-warning")}>
                    <span className={cn("h-1.5 w-1.5 rounded-full", DOT[r.freshness])} />
                    {r.lastRun ? `${r.labels.lastRun} ${r.lastRun}` : r.labels.neverRun}
                  </span>
                )}
                {r.schedules > 0 && (
                  <span className="inline-flex items-center gap-1" title={r.labels.scheduled}>
                    <Clock className="h-3 w-3" /> {r.schedules}
                  </span>
                )}
                {r.blocks > 0 && <span>{r.blocks} {r.labels.blocks}</span>}
              </div>
            </div>
          </div>
        </Link>

        {/* Actions menu — positioned inside the card but above the link. Always
            visible (not hover-only) so it is reachable on touch screens. */}
        <div className="absolute right-2 top-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                title="More actions"
                className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card shadow-xs hover:bg-muted"
              >
                <MoreVertical className="h-4 w-4 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem onClick={() => router.push(r.href)}>
                <ExternalLink className="mr-2 h-4 w-4" /> Open
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => router.push(r.editHref)}>
                <Pencil className="mr-2 h-4 w-4" /> Edit
              </DropdownMenuItem>
              {isAdmin && r.kind === "report" && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => setConfirming(true)}
                    className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                  >
                    <Trash2 className="mr-2 h-4 w-4" /> Delete…
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {confirming && (
        <DeleteReportDialog
          reportId={r.id}
          reportName={r.name}
          onClose={() => setConfirming(false)}
          onDeleted={() => { setConfirming(false); router.refresh(); }}
        />
      )}
    </>
  );
}
