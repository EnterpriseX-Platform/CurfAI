"use client";
/**
 * SlowQueryBanner — appears on the report viewer when recent runs are
 * trending slow. One click sends the admin to /tables with a query param
 * that pre-opens the materialized view create form scoped to this report.
 *
 * Renders nothing for fast reports (the common case). Self-dismisses to
 * sessionStorage when the user clicks "Don't show me this again", so the
 * banner doesn't nag every viewer load on a known-slow report the admin
 * doesn't intend to fix.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Layers, X, Clock, Sparkles } from "lucide-react";

type Stats = {
  slow: boolean;
  runCount: number;
  slowCount: number;
  avgMs: number;
  maxMs: number;
  threshold: number;
  reportName: string;
};

export function SlowQueryBanner({ reportId, isAdmin }: { reportId: string; isAdmin: boolean }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const dismissKey = "curf:slow-banner:dismiss:" + reportId;

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.sessionStorage.getItem(dismissKey) === "1") {
      setDismissed(true);
      return;
    }
    let cancelled = false;
    fetch(`/api/reports/${reportId}/slow-stats`, { credentials: "include", cache: "no-store" })
      .then((r) => r.ok ? r.json() : null)
      .then((j) => { if (!cancelled && j) setStats(j); })
      .catch(() => { /* silent — best-effort surface */ });
    return () => { cancelled = true; };
  }, [reportId, dismissKey]);

  if (!stats || !stats.slow || dismissed) return null;
  // Only admins/editors can create MVs; viewers see nothing actionable, so
  // hide the banner from them entirely rather than show a teasing CTA.
  if (!isAdmin) return null;

  function dismiss() {
    if (typeof window !== "undefined") window.sessionStorage.setItem(dismissKey, "1");
    setDismissed(true);
  }

  const avgSec = (stats.avgMs / 1000).toFixed(2);
  const maxSec = (stats.maxMs / 1000).toFixed(2);

  return (
    <div className="mx-auto mb-4 flex max-w-6xl items-start gap-3 rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning  ">
      <Clock className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          This report is running slow.
          <span className="ml-1.5 font-normal text-warning/80 ">
            Avg <span className="font-mono tabular-nums">{avgSec}s</span> across {stats.runCount} runs in the last 7 days · {stats.slowCount} run{stats.slowCount === 1 ? "" : "s"} over {(stats.threshold / 1000).toFixed(0)}s · max <span className="font-mono tabular-nums">{maxSec}s</span>.
          </span>
        </p>
        <p className="mt-1 text-[12px] text-warning/80 ">
          Cache it as a <span className="font-medium">materialized view</span> — the result rebuilds on a cron and readers get it from a lake table in milliseconds.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Link
          href={`/tables?suggestMv=${encodeURIComponent(reportId)}#materialized-views`}
          className="inline-flex items-center gap-1 rounded-md border border-warning/50 bg-warning/20 px-2.5 py-1.5 text-[12px] font-semibold text-warning hover:bg-warning/30 "
        >
          <Layers className="h-3.5 w-3.5" /> Cache as MV
        </Link>
        <button
          type="button"
          onClick={dismiss}
          className="rounded-md p-1 text-warning/70 hover:bg-warning/20 hover:text-warning  "
          title="Hide this banner for this session"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
