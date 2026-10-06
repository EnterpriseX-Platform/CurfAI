/**
 * Lake-domain cron tick handlers, extracted verbatim out of
 * src/app/api/cron/tick/route.ts's handle() — that function had grown to
 * ~420 lines covering 18 unrelated scheduled concerns in one body. Each
 * function here is the exact original code block, just given a name and a
 * signature; none of the logic, error handling, or fired-array mutation
 * semantics changed.
 */
import { prisma } from "@/lib/db";
import { cronMatches } from "@/lib/cron/cronMatches";
import { acquireLeaseOn, releaseLeaseOn } from "@/lib/cron/leases";
import type { FiredItem } from "./types";

// Single-process dev-appropriate constant — same precedent as
// sync/scheduler.ts's own default `workerId: "cron"` (see its doc comment).
const WORKER_ID = "cron";

/**
 * E2 Phase A/C (E2_JOBS_SCOPING_PLAN.md §4/§5) — best-effort JobRun bookkeeping
 * shared by every Phase C tick below. A JobRun write failure must never break
 * the actual tick, so every call is via this helper, which swallows its own
 * errors, mirroring sync/scheduler.ts's dispatchDueSyncs (the reference
 * implementation).
 */
async function startJobRun(args: { tenantId: string; kind: string; targetId: string; targetLabel: string }): Promise<string | null> {
  return (await prisma.jobRun.create({ data: { ...args, status: "running" } }).catch(() => null))?.id ?? null;
}
async function finishJobRun(jobRunId: string | null, data: { status: "ok" | "failed"; rowsAffected?: number; error?: string }): Promise<void> {
  if (!jobRunId) return;
  await prisma.jobRun.update({ where: { id: jobRunId }, data: { finishedAt: new Date(), ...data } }).catch(() => null);
}

// Lake pulls — separate model from Schedule, but driven by the same
// tick. Each enabled LakePull whose cron matches now runs a REST fetch
// and materialises the rows into its named lake table. Failures get
// persisted on the LakePull row so /admin can surface broken ones.
//
// E2 Phase C: leased the same way sync's SyncJob already is (see
// lib/cron/leases.ts) — two cron ticks (replicas, a manual trigger racing
// the scheduled one) racing the same LakePull used to both run the REST
// fetch concurrently; now exactly one wins, the other skips this tick.
export async function tickLakePulls(fired: FiredItem[], now: Date, force: boolean): Promise<void> {
  let pulls: any[] = [];
  try {
    pulls = await prisma.lakePull.findMany({ where: { enabled: true } });
  } catch {
    /* model missing pre-prisma-db-push — ignore */
  }
  for (const p of pulls) {
    if (!force && !cronMatches(p.cron, now)) continue;
    if (!(await acquireLeaseOn(prisma.lakePull, { id: p.id, workerId: WORKER_ID }))) continue;
    let jobRunId: string | null = null;
    try {
      jobRunId = await startJobRun({ tenantId: p.tenantId, kind: "restPull", targetId: p.id, targetLabel: p.name });
      const { runLakePull } = await import("@/lib/lake/restPull");
      const r = await runLakePull(p.id);
      fired.push({ id: p.id, kind: "lake_pull", status: r.status, narrative: `wrote ${r.rowsWritten} rows to ${p.tableName}` });
      await finishJobRun(jobRunId, { status: r.status === "failed" ? "failed" : "ok", rowsAffected: r.rowsWritten });
    } catch (e: any) {
      fired.push({ id: p.id, kind: "lake_pull", status: "failed", narrative: e?.message });
      await finishJobRun(jobRunId, { status: "failed", error: (e?.message ?? String(e)).slice(0, 500) });
    } finally {
      await releaseLeaseOn(prisma.lakePull, { id: p.id, workerId: WORKER_ID });
    }
  }
}

// Materialized views — same shape as lake pulls. Each enabled MV with
// a cron that matches now triggers a recompute. MVs without a cron
// (manual-refresh-only) are skipped here. Leased the same way (E2 Phase C).
export async function tickMaterializedViews(fired: FiredItem[], now: Date, force: boolean): Promise<void> {
  let mvs: any[] = [];
  try {
    mvs = await prisma.materializedView.findMany({ where: { enabled: true, cron: { not: null } } });
  } catch {
    /* model missing pre-prisma-db-push — ignore */
  }
  for (const mv of mvs) {
    if (!force && !cronMatches(mv.cron, now)) continue;
    if (!(await acquireLeaseOn(prisma.materializedView, { id: mv.id, workerId: WORKER_ID }))) continue;
    let jobRunId: string | null = null;
    try {
      jobRunId = await startJobRun({ tenantId: mv.tenantId, kind: "materialize", targetId: mv.id, targetLabel: mv.name });
      const { refreshMaterializedView } = await import("@/lib/lake/materialize");
      const r = await refreshMaterializedView(mv.id);
      fired.push({ id: mv.id, kind: "materialized_view", status: r.status, narrative: `${mv.name}: ${r.rowCount} rows in ${r.durationMs}ms` });
      await finishJobRun(jobRunId, { status: r.status === "failed" ? "failed" : "ok", rowsAffected: r.rowCount });
    } catch (e: any) {
      fired.push({ id: mv.id, kind: "materialized_view", status: "failed", narrative: e?.message });
      await finishJobRun(jobRunId, { status: "failed", error: (e?.message ?? String(e)).slice(0, 500) });
    } finally {
      await releaseLeaseOn(prisma.materializedView, { id: mv.id, workerId: WORKER_ID });
    }
  }
}

// Nightly lake backups — one snapshot per tenant per day (snapshotTenant
// skips if the previous auto snapshot is <23h old, so calling this
// every tick is cheap). Then sweep tier-aged backups in the same pass.
// We only run the whole sweep at 02:00 cron-time to avoid hitting it
// every minute.
export async function tickLakeBackups(fired: FiredItem[], now: Date, force: boolean): Promise<void> {
  if (!(force || (now.getUTCHours() === 2 && now.getUTCMinutes() === 0))) return;
  try {
    const { snapshotTenant, sweepOldBackups } = await import("@/lib/lake/backup");
    const tenants = await prisma.tenant.findMany({ select: { id: true } });
    for (const t of tenants) {
      try {
        const snap = await snapshotTenant({ tenantId: t.id, kind: "auto" });
        if (snap.skipped) continue;
        fired.push({ id: snap.backupId, kind: "lake_backup", status: "ok", narrative: `snapshot ${(snap.sizeBytes / 1024).toFixed(0)} KB` });
        await sweepOldBackups(t.id);
      } catch (e: any) {
        fired.push({ id: t.id, kind: "lake_backup", status: "failed", narrative: e?.message });
      }
    }
  } catch (e: any) {
    console.warn("[cron] backup sweep failed:", e?.message);
  }
}

// Checks every hour whether a table needs a new time-travel snapshot
// row, but only mints one when a fresh nightly backup has landed since
// the last check (see mintBackupSnapshots' doc comment) — so resolution
// for readTableAsOf() tracks backup frequency, not this check interval.
export async function tickBackupSnapshots(fired: FiredItem[], now: Date, force: boolean): Promise<void> {
  if (!(force || now.getUTCMinutes() === 0)) return;
  try {
    const { mintBackupSnapshots } = await import("@/lib/lake/timeTravel");
    const tenants = await prisma.tenant.findMany({ select: { id: true } });
    let total = 0;
    for (const t of tenants) {
      const r = await mintBackupSnapshots(t.id).catch(() => ({ created: 0 }));
      total += r.created;
    }
    if (total > 0) fired.push({ id: "backup-snapshots", kind: "lake_snapshot", status: "ok", narrative: `${total} table snapshots minted` });
  } catch (e: any) {
    console.warn("[cron] backup snapshot mint failed:", e?.message);
  }
}
