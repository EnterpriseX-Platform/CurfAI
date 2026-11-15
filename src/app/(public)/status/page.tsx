/**
 * Public canary status page — Curf (Harness 6).
 *
 * Renders the last 100 canary runs as a green/red bar chart plus a
 * percent-uptime stat. Server component, no auth required.
 *
 * Data source — placeholder:
 *   We deliberately avoid adding a `CanaryRun` Prisma model in this PR
 *   because that requires a migration (and migration-gate.yml would pull
 *   that in front of every other schema change). Instead the page reads
 *   from a JSON file (default: `data/canary-runs.json`, override via
 *   `CANARY_RESULTS_FILE`). The shape matches what `scripts/canary.ts`
 *   posts to CANARY_RESULTS_URL — once we wire that endpoint, swap the
 *   file read here for a Prisma read.
 *
 * Roadmap follow-up: introduce the `CanaryRun` model + a writer endpoint
 * at /api/canary/results, then change `loadRuns()` below to query Prisma.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { t } from "@/lib/i18n/dict";
import { serverLocale } from "@/lib/i18n/serverLocale";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type CanaryRun = {
  ok: boolean;
  durationMs: number;
  failedStep: string | null;
  timestamp: string; // ISO 8601
};

async function loadRuns(): Promise<CanaryRun[]> {
  const file = process.env.CANARY_RESULTS_FILE || path.join(process.cwd(), "data", "canary-runs.json");
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Sort newest-first so the bar chart reads left-to-right as past->now
    // when reversed below.
    return parsed
      .filter((r): r is CanaryRun => r && typeof r.ok === "boolean" && typeof r.timestamp === "string")
      .slice(-100);
  } catch {
    return [];
  }
}

function formatRelative(iso: string, tr: (key: string) => string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const ageMs = Date.now() - t;
  const m = Math.floor(ageMs / 60_000);
  if (m < 1) return tr("status.justNow");
  if (m < 60) return tr("status.minutesAgo").replace("{n}", String(m));
  const h = Math.floor(m / 60);
  if (h < 24) return tr("status.hoursAgo").replace("{n}", String(h));
  const d = Math.floor(h / 24);
  return tr("status.daysAgo").replace("{n}", String(d));
}

export default async function StatusPage() {
  const locale = await serverLocale();
  const tr = (key: string) => t(locale, key);
  const runs = await loadRuns();
  const total = runs.length;
  const passes = runs.filter((r) => r.ok).length;
  const uptime = total > 0 ? (passes / total) * 100 : null;
  const last = runs[runs.length - 1] ?? null;

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">{tr("status.title")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {tr("status.intro")}
      </p>

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-xs uppercase text-muted-foreground">{tr("status.status")}</div>
          <div className="mt-1 text-2xl font-semibold">
            {tr(last == null ? "status.unknown" : last.ok ? "status.operational" : "status.degraded")}
          </div>
          {last && (
            <div className="mt-1 text-xs text-muted-foreground">
              {tr("status.lastCheck").replace("{when}", formatRelative(last.timestamp, tr))}
            </div>
          )}
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-xs uppercase text-muted-foreground">{tr("status.uptime")}</div>
          <div className="mt-1 text-2xl font-semibold">
            {uptime == null ? "—" : `${uptime.toFixed(1)}%`}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {total > 0 ? tr("status.runsPassed").replace("{passes}", String(passes)).replace("{total}", String(total)) : tr("status.noRunsYet")}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-xs uppercase text-muted-foreground">{tr("status.lastFailure")}</div>
          <div className="mt-1 text-sm">
            {(() => {
              const lastFail = [...runs].reverse().find((r) => !r.ok);
              if (!lastFail) return <span className="text-muted-foreground">{tr("status.noneInWindow")}</span>;
              return (
                <>
                  <div>{lastFail.failedStep ?? tr("status.unknownStep")}</div>
                  <div className="text-xs text-muted-foreground">{formatRelative(lastFail.timestamp, tr)}</div>
                </>
              );
            })()}
          </div>
        </div>
      </div>

      <div className="mt-10">
        <h2 className="text-sm font-medium text-muted-foreground">{tr("status.last100")}</h2>
        {total === 0 ? (
          <div className="mt-4 rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            {tr("status.empty")}
          </div>
        ) : (
          <div className="mt-3 flex items-end gap-[3px]">
            {runs.map((r, i) => (
              <div
                key={`${r.timestamp}-${i}`}
                className="h-8 w-2 rounded-sm"
                title={`${new Date(r.timestamp).toISOString()} — ${r.ok ? "PASS" : `FAIL (${r.failedStep ?? "unknown"})`} — ${r.durationMs}ms`}
                style={{
                  backgroundColor: r.ok ? "hsl(var(--success))" : "hsl(var(--destructive))",
                  opacity: r.ok ? 1 : 0.85,
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
