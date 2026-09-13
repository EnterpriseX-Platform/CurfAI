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
import type { FiredItem } from "./types";

// Lake pulls — separate model from Schedule, but driven by the same
// tick. Each enabled LakePull whose cron matches now runs a REST fetch
// and materialises the rows into its named lake table. Failures get
// persisted on the LakePull row so /admin can surface broken ones.
export async function tickLakePulls(fired: FiredItem[], now: Date, force: boolean): Promise<void> {
  let pulls: any[] = [];
  try {
    pulls = await prisma.lakePull.findMany({ where: { enabled: true } });
  } catch {
    /* model missing pre-prisma-db-push — ignore */
  }
  for (const p of pulls) {
    if (!force && !cronMatches(p.cron, now)) continue;
    try {
      const { runLakePull } = await import("@/lib/lake/restPull");
      const r = await runLakePull(p.id);
      fired.push({ id: p.id, kind: "lake_pull", status: r.status, narrative: `wrote ${r.rowsWritten} rows to ${p.tableName}` });
    } catch (e: any) {
      fired.push({ id: p.id, kind: "lake_pull", status: "failed", narrative: e?.message });
    }
  }
}

// Materialized views — same shape as lake pulls. Each enabled MV with
// a cron that matches now triggers a recompute. MVs without a cron
// (manual-refresh-only) are skipped here.
export async function tickMaterializedViews(fired: FiredItem[], now: Date, force: boolean): Promise<void> {
  let mvs: any[] = [];
  try {
    mvs = await prisma.materializedView.findMany({ where: { enabled: true, cron: { not: null } } });
  } catch {
    /* model missing pre-prisma-db-push — ignore */
  }
  for (const mv of mvs) {
    if (!force && !cronMatches(mv.cron, now)) continue;
    try {
      const { refreshMaterializedView } = await import("@/lib/lake/materialize");
      const r = await refreshMaterializedView(mv.id);
      fired.push({ id: mv.id, kind: "materialized_view", status: r.status, narrative: `${mv.name}: ${r.rowCount} rows in ${r.durationMs}ms` });
    } catch (e: any) {
      fired.push({ id: mv.id, kind: "materialized_view", status: "failed", narrative: e?.message });
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

// Hourly lake snapshots for time-travel reads. Cheap — one Prisma
// groupBy + N upserts. Skipped tenants with no recent backup are
// a no-op (the time-travel path returns null gracefully).
export async function tickHourlySnapshots(fired: FiredItem[], now: Date, force: boolean): Promise<void> {
  if (!(force || now.getUTCMinutes() === 0)) return;
  try {
    const { mintHourlySnapshots } = await import("@/lib/lake/timeTravel");
    const tenants = await prisma.tenant.findMany({ select: { id: true } });
    let total = 0;
    for (const t of tenants) {
      const r = await mintHourlySnapshots(t.id).catch(() => ({ created: 0 }));
      total += r.created;
    }
    if (total > 0) fired.push({ id: "hourly-snapshots", kind: "lake_snapshot", status: "ok", narrative: `${total} table snapshots minted` });
  } catch (e: any) {
    console.warn("[cron] hourly snapshot mint failed:", e?.message);
  }
}
