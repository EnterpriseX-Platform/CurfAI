"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Clock, Pencil, ExternalLink, MoreVertical, Trash2 } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { DeleteReportDialog } from "./DeleteReportDialog";

/** The card's thumbnail — the report's own last run, not a picture of it. */
export type ReportThumb = {
  kpis: Array<{ label: string; value: string; delta: string | null; good: boolean | null }>;
  bars: number[];
};

export type ReportCardData = {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  updatedAgo: string;
  version: number;
  ownerInitials: string;
  ownerName: string;
  /** Relative time of the last recorded run, or null when it never ran. */
  lastRun: string | null;
  /** ok = ran in the last 24h · warn = older · crit = last run failed · none = never ran */
  freshness: "ok" | "warn" | "crit" | "none";
  schedules: number;
  blocks: number;
  thumb: ReportThumb;
  /** Localised copy, resolved on the server so the card stays a pure renderer. */
  labels: { lastRun: string; neverRun: string; blocks: string; scheduled: string; empty: string };
};

const DOT: Record<ReportCardData["freshness"], string> = {
  ok: "bg-success", warn: "bg-warning", crit: "bg-destructive", none: "bg-faint",
};

export function ReportCard({ r, isAdmin }: { r: ReportCardData; isAdmin: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const max = Math.max(...r.thumb.bars, 0) || 1;
  const min = Math.min(...r.thumb.bars, max);
  const hasThumb = r.thumb.kpis.length > 0 || r.thumb.bars.length > 1;

  return (
    <>
      <div className="group relative">
        {/* Whole-card link: Open the report */}
        <Link
          href={`/reports/${r.id}`}
          className="flex flex-col overflow-hidden rounded-xl border border-border bg-card transition-all hover:-translate-y-px hover:border-input hover:shadow-md"
        >
          {/* Live thumbnail: mini KPI tiles from the last run + a short
              series. Empty until the report has run once. */}
          <div className="grid h-[136px] grid-cols-2 grid-rows-[auto_1fr] gap-2 border-b border-border bg-muted p-3">
            {hasThumb ? (
              <>
                {r.thumb.kpis.map((k, i) => (
                  <div key={i} className="min-w-0 rounded-md border border-border bg-card px-2.5 py-1.5">
                    <div className="truncate text-[9.5px] font-medium uppercase tracking-[.04em] text-faint">{k.label}</div>
                    <div className="truncate text-[15px] font-semibold leading-tight tracking-[-.01em] tabular-nums">{k.value}</div>
                    {k.delta && (
                      <div className={cn("text-[10.5px] font-medium tabular-nums", k.good === false ? "text-destructive" : "text-success")}>{k.delta}</div>
                    )}
                  </div>
                ))}
                {r.thumb.kpis.length === 1 && <div />}
                {r.thumb.bars.length > 1 && (
                  <div className="col-span-2 flex min-h-0 items-end gap-[5px] px-0.5">
                    {r.thumb.bars.map((v, i) => (
                      <i
                        key={i}
                        className={cn("block flex-1 rounded-t-[2px] bg-primary", i === r.thumb.bars.length - 1 ? "opacity-100" : "opacity-70")}
                        style={{ height: `${Math.max(8, Math.round(((v - min) / (max - min || 1)) * 70 + 30))}%` }}
                      />
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="col-span-2 row-span-2 flex items-center justify-center font-mono text-xs text-faint">{r.labels.empty}</div>
            )}
          </div>

          <div className="flex flex-col gap-2 px-3.5 py-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="truncate text-sm font-semibold tracking-tight" title={r.name}>{r.name}</h3>
              <span className="shrink-0 rounded-sm border border-border px-1.5 py-px font-mono text-[11px] text-faint">v{r.version}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-xs text-faint">
              <span
                className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-primary-soft font-sans text-[10px] font-semibold text-primary-ink"
                title={r.ownerName}
              >
                {r.ownerInitials}
              </span>
              <span className={cn("inline-flex items-center gap-1.5", r.freshness === "crit" && "text-destructive", r.freshness === "warn" && "text-warning")}>
                <span className={cn("h-2 w-2 rounded-full", DOT[r.freshness])} />
                {r.lastRun ? `${r.labels.lastRun} ${r.lastRun}` : r.labels.neverRun}
              </span>
              {r.schedules > 0 && (
                <span className="inline-flex items-center gap-1" title={r.labels.scheduled}>
                  <Clock className="h-3 w-3" /> {r.schedules}
                </span>
              )}
              {r.blocks > 0 && <span>{r.blocks} {r.labels.blocks}</span>}
              {r.category && <span className="rounded-sm border border-border px-1.5 py-px text-[11px]">{r.category}</span>}
            </div>
          </div>
        </Link>

        {/* Actions menu — positioned inside the card but above the link */}
        <div className="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
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
              <DropdownMenuItem onClick={() => router.push(`/reports/${r.id}`)}>
                <ExternalLink className="mr-2 h-4 w-4" /> Open
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => router.push(`/reports/${r.id}/edit`)}>
                <Pencil className="mr-2 h-4 w-4" /> Edit
              </DropdownMenuItem>
              {isAdmin && (
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
