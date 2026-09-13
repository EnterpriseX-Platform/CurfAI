"use client";
import { useT } from "@/lib/i18n/LocaleContext";

/**
 * SyncsManager — interactive bits for /admin/connections/[id]/syncs.
 *
 * For each SyncJob × source-object, render a status row with:
 *   - status chip (ok / partial / failed / running / never run)
 *   - rows-read / rows-written from the latest run
 *   - cursor value (truncated)
 *   - next-run countdown ("in 4h 12m")
 *   - Run-now button (POST /api/admin/syncs/[id]/run-now)
 *   - Pause / Resume toggle (POST /api/admin/syncs/[id]/pause)
 *   - Inline log expander that fetches /api/admin/syncs/[id]/runs
 *
 * Optimistic UI: pressing Run-now flips the row to "queued" instantly,
 * then refreshes the page state after ~1s so the next cron tick's
 * SyncRun row shows up. We don't poll — the user re-clicks "Refresh"
 * (header button) if they want a tighter loop.
 */
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/layout/PageHeader";
import {
  Play, Pause, Loader2, ChevronDown, ChevronUp, AlertTriangle, CircleDot, RefreshCw, Clock,
} from "lucide-react";

type Cursor = {
  cursorKind: string;
  cursorValue: string;
  rowsLastRun: number;
  lastRunAt: string | null;
  lastError: string | null;
} | undefined;

type Run = {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  rowsRead: number;
  rowsWritten: number;
  errorMessage: string | null;
};

type Job = {
  id: string;
  scheduleCron: string;
  objects: string[];
  enabled: boolean;
  nextRunAt: string;
  leasedBy: string | null;
  leasedUntil: string | null;
  latestRun: Run | null;
};

type Initial = {
  connection: { id: string; kind: string; name: string; enabled: boolean; createdAt: string };
  jobs: Job[];
  cursors: Record<string, any>;
};

export function SyncsManager({ initial }: { initial: Initial }) {
  const { t } = useT();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busyJobs, setBusyJobs] = useState<Set<string>>(new Set());
  const [openLog, setOpenLog] = useState<string | null>(null);

  function setBusy(jobId: string, busy: boolean) {
    setBusyJobs((s) => {
      const n = new Set(s);
      if (busy) n.add(jobId); else n.delete(jobId);
      return n;
    });
  }

  async function runNow(jobId: string) {
    setBusy(jobId, true);
    try {
      await fetch(`/api/admin/syncs/${jobId}/run-now`, { method: "POST", credentials: "include" });
    } finally {
      // Brief delay so the next cron tick (or a manual refresh) has a
      // chance to land a fresh SyncRun before we re-render.
      setTimeout(() => {
        setBusy(jobId, false);
        startTransition(() => router.refresh());
      }, 1200);
    }
  }

  async function togglePause(jobId: string, currentlyEnabled: boolean) {
    setBusy(jobId, true);
    try {
      await fetch(`/api/admin/syncs/${jobId}/pause`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !currentlyEnabled }),
      });
    } finally {
      setBusy(jobId, false);
      startTransition(() => router.refresh());
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        className="mb-0"
        title={initial.connection.name}
        description={<>{initial.connection.kind} · {t("admin.syncs.createdPrefix")} {new Date(initial.connection.createdAt).toLocaleDateString()}</>}
        actions={
          <button
            type="button"
            onClick={() => startTransition(() => router.refresh())}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-accent"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t("admin.syncs.refreshButton")}
          </button>
        }
      />

      {initial.jobs.length === 0 ? (
        <section className="rounded-lg border border-dashed border-border bg-muted/20 p-10 text-center">
          <Clock className="mx-auto h-8 w-8 text-muted-foreground/60" />
          <h3 className="mt-3 text-sm font-semibold">{t("admin.syncs.empty")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("admin.syncs.emptySubtitle")}
          </p>
        </section>
      ) : (
        <ul className="space-y-3">
          {initial.jobs.map((j) => (
            <JobRow
              key={j.id}
              job={j}
              cursors={initial.cursors}
              busy={busyJobs.has(j.id)}
              logOpen={openLog === j.id}
              onRunNow={() => runNow(j.id)}
              onTogglePause={() => togglePause(j.id, j.enabled)}
              onToggleLog={() => setOpenLog(openLog === j.id ? null : j.id)}
              t={t}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function JobRow({
  job, cursors, busy, logOpen, onRunNow, onTogglePause, onToggleLog, t,
}: {
  job: Job;
  cursors: Record<string, Cursor>;
  busy: boolean;
  logOpen: boolean;
  onRunNow: () => void;
  onTogglePause: () => void;
  onToggleLog: () => void;
  t: (key: string) => string;
}) {
  // Mount-gate the live-clock bits. The server renders this component
  // once at request time and the client re-renders it ~100ms later;
  // any value derived from Date.now() can flip between those moments
  // (lease just expired, schedule just became overdue). Defer the
  // clock-dependent UI to after hydration so React never sees a
  // mismatch — the chip and "Next run in N" string both appear after
  // the first effect tick.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const nextRun = new Date(job.nextRunAt);
  const dueIn = nextRun.getTime() - Date.now();
  const isOverdue = dueIn <= 0;
  const isLeased = mounted && job.leasedUntil && new Date(job.leasedUntil) > new Date();

  return (
    <li className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-4 px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">{job.scheduleCron}</span>
            {!job.enabled && (
              <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-warning">
                {t("dashboardViewer.paused")}
              </span>
            )}
            {isLeased && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary-ink">
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                {t("admin.lineage.freshnessRunning")}
              </span>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>
              <span className="font-semibold text-foreground">{job.objects.length}</span> {job.objects.length === 1 ? t("admin.syncs.objectSingular") : t("admin.syncs.objectPlural")}: <span className="font-mono">{job.objects.join(", ") || "—"}</span>
            </span>
            <span className="opacity-40">·</span>
            <span suppressHydrationWarning>
              {isOverdue ? t("admin.syncs.dueNow") : t("admin.syncs.nextRunIn").replace("{delta}", formatDelta(dueIn, t))}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onRunNow}
            disabled={busy || !job.enabled}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground/80 hover:bg-accent disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            {t("admin.syncs.runNowButton")}
          </button>
          <button
            type="button"
            onClick={onTogglePause}
            disabled={busy}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground/80 hover:bg-accent disabled:opacity-50"
          >
            {job.enabled ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            {job.enabled ? t("action.pause") : t("action.resume")}
          </button>
          <button
            type="button"
            onClick={onToggleLog}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground/80 hover:bg-accent"
          >
            {logOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {t("admin.syncs.logButton")}
          </button>
        </div>
      </div>

      {/* Per-object status table */}
      {job.objects.length > 0 && (
        <div className="border-t border-border bg-muted/20">
          <table className="w-full text-xs">
            <thead className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-5 py-2 font-medium">{t("admin.syncs.colObject")}</th>
                <th className="px-3 py-2 font-medium">{t("admin.syncs.colStatus")}</th>
                <th className="px-3 py-2 font-medium">{t("admin.syncs.colRowsLastRun")}</th>
                <th className="px-3 py-2 font-medium">{t("admin.syncs.colCursor")}</th>
                <th className="px-5 py-2 font-medium">{t("admin.syncs.colLastRun")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {job.objects.map((obj) => {
                const cur = cursors[obj];
                const status = cur?.lastError ? "failed" : (cur ? "ok" : "never");
                return (
                  <tr key={obj}>
                    <td className="px-5 py-2 font-mono text-foreground/90">{obj}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1">
                        <CircleDot className={`h-2.5 w-2.5 ${statusDot(status)}`} />
                        <span className="capitalize">{statusLabel(status, t)}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{cur?.rowsLastRun ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">
                      {cur?.cursorValue ? truncate(cur.cursorValue, 32) : "—"}
                    </td>
                    <td className="px-5 py-2 text-muted-foreground" suppressHydrationWarning>
                      {cur?.lastRunAt ? formatRelative(new Date(cur.lastRunAt), t) : t("common.never")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Latest run error (if any) — surface inline, no need to open log.
          We pattern-match the error against a small map of common
          connector failures and append a "what to do" hint underneath.
          Raw message stays visible verbatim — pilots / oncall need it
          for issue tickets and for cases the hint doesn't cover. */}
      {job.latestRun?.errorMessage && job.latestRun.status === "failed" && (
        <div className="border-t border-border bg-destructive/10 px-5 py-3">
          <div className="flex items-start gap-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-mono break-words">{job.latestRun.errorMessage}</p>
              {errorHint(job.latestRun.errorMessage, t) && (
                <p className="mt-1.5 text-destructive/80">
                  <span className="font-medium">{t("admin.syncs.tryPrefix")}</span> {errorHint(job.latestRun.errorMessage, t)}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Log expander */}
      {logOpen && <LogExpander jobId={job.id} t={t} />}
    </li>
  );
}

function LogExpander({ jobId, t }: { jobId: string; t: (key: string) => string }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [loading, setLoading] = useState(false);

  // Lazy fetch on first open. Subsequent re-opens reuse the cached
  // list — the "Refresh" header button up top is the way to re-pull.
  if (runs === null && !loading) {
    setLoading(true);
    fetch(`/api/admin/syncs/${jobId}/runs?limit=50`, { credentials: "include" })
      .then((r) => r.json())
      .then((j) => setRuns(j.runs ?? []))
      .finally(() => setLoading(false));
  }

  return (
    <div className="border-t border-border bg-muted/10 px-5 py-3">
      <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{t("admin.syncs.recentRunsHeading")}</h4>
      {loading && runs === null && (
        <p className="text-xs text-muted-foreground">{t("admin.webhooks.loading")}</p>
      )}
      {runs && runs.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("admin.syncs.noRunsYet")}</p>
      )}
      {runs && runs.length > 0 && (
        <ul className="divide-y divide-border rounded border border-border bg-background">
          {runs.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-3 py-2 text-xs">
              <CircleDot className={`h-2 w-2 shrink-0 ${statusDot(r.status)}`} />
              <span className="w-32 shrink-0 font-mono text-muted-foreground" suppressHydrationWarning>
                {new Date(r.startedAt).toLocaleTimeString()}
              </span>
              <span className="w-20 shrink-0 capitalize">{statusLabel(r.status, t)}</span>
              <span className="w-24 shrink-0 text-muted-foreground">
                {r.rowsRead}→{r.rowsWritten}
              </span>
              <span className="flex-1 truncate font-mono text-[11px] text-destructive">
                {r.errorMessage ?? ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Map common connector failure messages → "what to do" hints. Return
 * null if the message doesn't match anything in the table; the raw
 * error still renders verbatim above this hint, so an unmatched error
 * gracefully degrades to "just the raw message" rather than implying
 * the platform doesn't know what's wrong.
 *
 * Match against substrings, not exact equality — the connectors prefix
 * the per-object name (e.g. "customers: Invalid API Key provided: …").
 */
function errorHint(msg: string, t: (key: string) => string): string | null {
  const m = msg.toLowerCase();
  if (m.includes("econnrefused"))
    return t("admin.syncs.hintEconnrefused");
  if (m.includes("invalid api key"))
    return t("admin.syncs.hintInvalidApiKey");
  if (m.includes("password authentication failed"))
    return t("admin.syncs.hintPasswordAuth");
  if (m.includes("relation") && m.includes("does not exist"))
    return t("admin.syncs.hintRelationNotExist");
  if (m.includes("permission denied"))
    return t("admin.syncs.hintPermissionDenied");
  if (m.includes("time zone") && m.includes("not recognized"))
    return t("admin.syncs.hintTimeZone");
  if (m.includes("nosyncobjectmap") || m.includes("no syncobjectmap"))
    return t("admin.syncs.hintNoSyncObjectMap");
  if (m.includes("decrypt failed"))
    return t("admin.syncs.hintDecryptFailed");
  if (m.includes("rate limit") || m.includes("429"))
    return t("admin.syncs.hintRateLimit");
  return null;
}

function statusLabel(status: string, t: (key: string) => string): string {
  switch (status) {
    case "ok":      return t("admin.syncs.statusOk");
    case "partial": return t("admin.syncs.statusPartial");
    case "failed":  return t("operate.status.failed");
    case "running": return t("admin.lineage.freshnessRunning");
    case "never":   return t("common.never");
    default:        return status;
  }
}

function statusDot(status: string): string {
  switch (status) {
    case "ok":      return "text-success";
    case "partial": return "text-warning";
    case "failed":  return "text-destructive";
    case "running": return "text-primary";
    case "never":   return "text-muted-foreground/40";
    default:        return "text-muted-foreground/50";
  }
}

function formatDelta(ms: number, t: (key: string) => string): string {
  if (ms <= 0) return t("admin.newConnectionWizard.relNow");
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const rem = min % 60;
  if (hr < 24) return rem ? `${hr}h ${rem}m` : `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

function formatRelative(d: Date, t: (key: string) => string): string {
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return t("time.secondsAgo").replace("{n}", String(sec));
  const min = Math.floor(sec / 60);
  if (min < 60) return t("time.minutesAgo").replace("{n}", String(min));
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("time.hoursAgo").replace("{n}", String(hr));
  const day = Math.floor(hr / 24);
  if (day < 7) return t("time.daysAgo").replace("{n}", String(day));
  return d.toLocaleDateString();
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
