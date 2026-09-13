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

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const ageMs = Date.now() - t;
  const m = Math.floor(ageMs / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default async function StatusPage() {
  const runs = await loadRuns();
  const total = runs.length;
  const passes = runs.filter((r) => r.ok).length;
  const uptime = total > 0 ? (passes / total) * 100 : null;
  const last = runs[runs.length - 1] ?? null;

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Curf status</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Synthetic canary runs the critical path (plan → apply → regenerate →
        export PDF → teardown) every 10 minutes. The last 100 results are
        shown below.
      </p>

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-xs uppercase text-muted-foreground">Status</div>
          <div className="mt-1 text-2xl font-semibold">
            {last == null ? "Unknown" : last.ok ? "Operational" : "Degraded"}
          </div>
          {last && (
            <div className="mt-1 text-xs text-muted-foreground">
              last check {formatRelative(last.timestamp)}
            </div>
          )}
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-xs uppercase text-muted-foreground">100-run uptime</div>
          <div className="mt-1 text-2xl font-semibold">
            {uptime == null ? "—" : `${uptime.toFixed(1)}%`}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {total > 0 ? `${passes} / ${total} runs passed` : "no runs recorded yet"}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-xs uppercase text-muted-foreground">Last failure</div>
          <div className="mt-1 text-sm">
            {(() => {
              const lastFail = [...runs].reverse().find((r) => !r.ok);
              if (!lastFail) return <span className="text-muted-foreground">none in window</span>;
              return (
                <>
                  <div>{lastFail.failedStep ?? "unknown step"}</div>
                  <div className="text-xs text-muted-foreground">{formatRelative(lastFail.timestamp)}</div>
                </>
              );
            })()}
          </div>
        </div>
      </div>

      <div className="mt-10">
        <h2 className="text-sm font-medium text-muted-foreground">Last 100 runs</h2>
        {total === 0 ? (
          <div className="mt-4 rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No canary runs recorded yet. Set <code>CANARY_BASE_URL</code> and
            <code className="ml-1">CANARY_API_KEY</code> in CI to activate, then
            wire <code>CANARY_RESULTS_URL</code> to the writer endpoint.
          </div>
        ) : (
          <div className="mt-3 flex items-end gap-[3px]">
            {runs.map((r, i) => (
              <div
                key={`${r.timestamp}-${i}`}
                className="h-8 w-2 rounded-sm"
                title={`${new Date(r.timestamp).toISOString()} — ${r.ok ? "PASS" : `FAIL (${r.failedStep ?? "unknown"})`} — ${r.durationMs}ms`}
                style={{
                  backgroundColor: r.ok ? "#10b981" /* emerald-500 */ : "#f43f5e" /* rose-500 */,
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
