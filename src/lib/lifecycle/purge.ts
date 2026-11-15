/**
 * The purge: what actually removes a workspace once its grace period (lib/lifecycle/deletion.ts) has ended.
 *
 * "Deleted" has to be true. So this removes, in this order, and records each step in the deletion certificate
 * (WorkspaceDeletion):
 *   1. quiesces the workspace in this process (stops buffered writes, closes its lake handle, drops its caches) so
 *      nothing recreates a file after it is removed;
 *   2. every file on disk (lib/lifecycle/files.ts) — lake, imports, branches, backups, Parquet, uploads, assets, exports;
 *   3. every database row keyed to the workspace — including the dozen tables that carry a plain tenantId and do NOT
 *      cascade from Tenant — counting what went; then checks nothing is left;
 *   4. only then the workspace row itself (everything with a real foreign key goes with it);
 *   5. what that leaves behind: the organization if it has no other workspace, external app viewers who had access to
 *      nothing else, and accounts whose only workspace this was.
 * Failing at any point leaves the workspace in "pending_deletion", records the error, and is retried by the next tick —
 * every step is safe to repeat. The audit trail is not removed here: it is kept for CURF_AUDIT_AFTER_PURGE_DAYS (default
 * 365) and then removed by purgeAuditAfterRetention.
 *
 * What it cannot remove, and says so: copies the customer shipped to their own off-site storage (we only hold a
 * presigned upload URL, not a key that can delete), and a backup of the whole platform taken before the purge.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { withSystemDbContext } from "@/lib/dbContext";
import { persistAudit } from "@/lib/audit";
import { forgetTenantStatus } from "@/lib/tenantGuard";
import { closeLake } from "@/lib/lake/storage";
import { ee } from "@/ee";
import { bustTenantCache } from "@/lib/reporting/queryCache";
import { forgetLakeCatalog } from "@/lib/lake/dateColumnNames";
import { optionalModel, withModel } from "./optionalModel";
import { assertSafeTenantId, removeWorkspaceFiles, workspaceFilesRemaining, workspaceFileTargets } from "./files";
import { removeOrphanedUser } from "./person";
import { LifecycleError } from "./deletion";
import fs from "node:fs";

export type PurgeStep = { step: string; ok: boolean; detail?: Record<string, unknown>; error?: string };
export type PurgeReport = { ok: boolean; tenantId: string; steps: PurgeStep[] };

/** Rows with a tenantId that must outlive the workspace: the audit trail (kept, then removed on its own schedule). */
const KEEP_MODELS = new Set(["AuditEvent"]);

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Every model with a plain tenantId column — found from the schema, so a new table is covered without anyone remembering to add it. */
export function tenantScopedModels(): string[] {
  return Prisma.dmmf.datamodel.models
    .filter((m) => !KEEP_MODELS.has(m.name) && m.fields.some((f) => f.name === "tenantId" && f.kind === "scalar"))
    .map((m) => m.name);
}

function delegate(model: string): any | null {
  const d = (prisma as any)[lowerFirst(model)];
  return d && typeof d.deleteMany === "function" && typeof d.count === "function" ? d : null;
}

async function countRows(tenantId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const m of tenantScopedModels()) {
    const d = delegate(m);
    if (!d) continue;
    const n: number = await d.count({ where: { tenantId } });
    if (n > 0) out[m] = n;
  }
  return out;
}

/** Sync data hangs off a connection, not off the workspace: SyncJob, SyncRun, SyncCursor and SyncObjectMap have no tenantId. */
async function deleteSyncChildren(tenantId: string): Promise<number> {
  const conns = await prisma.syncConnection.findMany({ where: { tenantId }, select: { id: true } });
  const ids = conns.map((c) => c.id);
  if (ids.length === 0) return 0;
  let n = 0;
  // Not every edition has every one of these tables (optionalModel.ts).
  for (const name of ["syncRun", "syncJob", "syncCursor", "syncObjectMap"]) {
    const m = optionalModel(name);
    if (m) n += (await m.deleteMany({ where: { connectionId: { in: ids } } })).count as number;
  }
  return n;
}

/**
 * Delete every row keyed to the workspace, in as many passes as foreign keys need (a child table can only go once its
 * parent's rows are gone, and the order of models is not the order of dependencies). Returns what was removed and what
 * (if anything) would not go.
 */
async function sweepRows(tenantId: string): Promise<{ removed: Record<string, number>; syncChildren: number; remaining: Record<string, number> }> {
  const removed: Record<string, number> = {};
  const syncChildren = await deleteSyncChildren(tenantId);
  let pending = tenantScopedModels();
  for (let pass = 0; pass < 5 && pending.length > 0; pass++) {
    const next: string[] = [];
    for (const m of pending) {
      const d = delegate(m);
      if (!d) continue;
      try {
        const r = await d.deleteMany({ where: { tenantId } });
        if (r.count > 0) removed[m] = (removed[m] ?? 0) + r.count;
        // A row that is still there after this (a parent not yet deleted) is caught by the check below.
      } catch {
        next.push(m); // blocked by a foreign key from a table not yet emptied: try again next pass
      }
    }
    pending = next;
  }
  return { removed, syncChildren, remaining: await countRows(tenantId) };
}

export type PurgeOptions = { now?: Date; dryRun?: boolean };

/**
 * Purge one workspace. Refuses unless it is scheduled for deletion and its grace period has ended; `dryRun` reports what
 * would be removed and changes nothing.
 */
export async function purgeWorkspace(tenantId: string, opts: PurgeOptions = {}): Promise<PurgeReport> {
  assertSafeTenantId(tenantId);
  const now = opts.now ?? new Date();
  const steps: PurgeStep[] = [];
  const record = (s: PurgeStep) => { steps.push(s); return s; };

  return withSystemDbContext(async () => {
    const t = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true, name: true, status: true, deletionPurgeAt: true, deletionRequestedBy: true, organizationId: true },
    });
    if (!t) throw new LifecycleError("Workspace not found", 404);
    if (t.status !== "pending_deletion") throw new LifecycleError("This workspace is not scheduled for deletion", 409);
    if (!opts.dryRun && (!t.deletionPurgeAt || t.deletionPurgeAt.getTime() > now.getTime())) {
      throw new LifecycleError("The grace period has not ended", 409);
    }

    // ---- facts to collect while the workspace still exists -----------------------------------------------------
    const [members, grants, backups, shipments, destinations, rows] = await Promise.all([
      prisma.membership.findMany({ where: { tenantId }, select: { userId: true } }),
      withModel("appViewerGrant", (m) => m.findMany({ where: { tenantId }, select: { viewerId: true } }), [] as Array<{ viewerId: string }>),
      prisma.lakeBackup.findMany({ where: { tenantId }, select: { id: true } }),
      withModel("backupShipment", (m) => m.count({ where: { tenantId } }), 0 as number),
      withModel("backupDestination", (m) => m.count({ where: { tenantId } }), 0 as number),
      countRows(tenantId),
    ]);
    const memberIds = Array.from(new Set(members.map((m) => m.userId)));
    const viewerIds = Array.from(new Set(grants.map((g) => g.viewerId)));
    const scratch = backups.map((b) => `curf-snap-${b.id}.db`);

    if (opts.dryRun) {
      const files = (await workspaceFileTargets(tenantId)).filter((x) => fs.existsSync(x.path)).map((x) => x.what);
      record({ step: "dry run", ok: true, detail: { rows, files, offsiteShipments: shipments, offsiteDestinations: destinations } });
      return { ok: true, tenantId, steps };
    }

    await persistAudit({ tenantId, userEmail: null, kind: "tenant.purge.start", target: tenantId, meta: { slug: t.slug, requestedBy: t.deletionRequestedBy } });

    try {
      // ---- 1. nothing in this process may write to it any more ------------------------------------------------
      closeLake(tenantId);
      bustTenantCache(tenantId);
      forgetLakeCatalog(tenantId);
      // The paid lake keeps its own state (engine handles, streaming buffers, lineage): the paid edition lets go of it.
      const droppedRows = (await ee.lifecycle?.quiesce(tenantId)) ?? 0;
      forgetTenantStatus(tenantId);
      record({ step: "quiesce", ok: true, detail: { bufferedRowsDiscarded: droppedRows } });

      // ---- 2. files -------------------------------------------------------------------------------------------
      const removedFiles = await removeWorkspaceFiles(tenantId, scratch);
      const left = await workspaceFilesRemaining(tenantId);
      if (left.length > 0) throw new Error(`files still on disk after removal: ${left.join(", ")}`);
      record({ step: "files", ok: true, detail: { removed: removedFiles.filter((f) => f.existed) } });

      // ---- 3. rows --------------------------------------------------------------------------------------------
      const swept = await sweepRows(tenantId);
      const stuck = Object.entries(swept.remaining);
      if (stuck.length > 0) throw new Error(`rows still in the database after the sweep: ${stuck.map(([m, n]) => `${m}×${n}`).join(", ")}`);
      record({ step: "rows", ok: true, detail: { removedBeforeDelete: swept.removed, syncChildren: swept.syncChildren, countedBefore: rows } });

      // ---- 4. the workspace itself (and everything with a real foreign key to it) -----------------------------
      await prisma.tenant.delete({ where: { id: tenantId } });
      record({ step: "workspace", ok: true });

      // ---- 5. what the workspace leaves behind ----------------------------------------------------------------
      const after: Record<string, unknown> = {};
      if (t.organizationId) {
        const others = await prisma.tenant.count({ where: { organizationId: t.organizationId } });
        if (others === 0) { await prisma.organization.deleteMany({ where: { id: t.organizationId } }); after.organizationDeleted = true; }
        else after.organizationKept = `${others} other workspace(s)`;
      }
      let viewersDeleted = 0;
      for (const id of viewerIds) {
        const viewer = optionalModel("appViewer");
        if (!viewer) break;
        const r = await viewer.deleteMany({ where: { id, grants: { none: {} } } });
        viewersDeleted += r.count as number;
      }
      after.externalViewersDeleted = viewersDeleted;
      // An account whose only workspace this was has nothing left to do here: removed, or — if something elsewhere still
      // points at it — anonymised. An operator's, or one that belongs somewhere else, is kept.
      const accounts = { deleted: 0, anonymized: 0, kept: 0 };
      for (const id of memberIds) accounts[await removeOrphanedUser(id)]++;
      after.accounts = accounts;
      record({ step: "left behind", ok: true, detail: after });

      record({
        step: "not removed", ok: true,
        detail: {
          auditTrail: "kept for the audit retention period, then removed",
          taxDocuments: "invoices, tax invoices / receipts and credit notes issued to the organisation are kept: Thai tax law requires them to be retained for years, and they are not tied to the workspace",
          offsiteCopies: shipments > 0 || destinations > 0
            ? `${shipments} shipment(s) to ${destinations} destination(s) the customer configured; we hold no key to delete them — the customer must`
            : "none",
          platformBackups: "a backup of the whole platform taken before this purge still holds this data until it expires",
        },
      });

      await prisma.workspaceDeletion.updateMany({
        where: { targetTenantId: tenantId },
        data: { status: "purged", purgedAt: now, stepsJson: JSON.stringify(steps) },
      });
      await persistAudit({ tenantId, userEmail: null, kind: "tenant.purge.done", target: tenantId, meta: { slug: t.slug, steps: steps.map((s) => s.step) } });
      return { ok: true, tenantId, steps };
    } catch (e: any) {
      record({ step: "failed", ok: false, error: String(e?.message ?? e).slice(0, 500) });
      await prisma.workspaceDeletion.updateMany({ where: { targetTenantId: tenantId }, data: { stepsJson: JSON.stringify(steps) } }).catch(() => null);
      await persistAudit({ tenantId, userEmail: null, kind: "tenant.purge.failed", target: tenantId, meta: { error: String(e?.message ?? e).slice(0, 300) } }).catch(() => null);
      return { ok: false, tenantId, steps };
    }
  });
}

/**
 * The cron entry point: purge the workspaces whose grace period has ended, one per tick (a purge of a big workspace can
 * take a while, and it picks up where it left off if a tick is cut short).
 */
export async function sweepPurges(now: Date = new Date()): Promise<{ purged: string[]; failed: string[] }> {
  const due = await withSystemDbContext(() => prisma.tenant.findMany({
    // nosemgrep: prisma-must-include-tenant -- the sweep over every workspace whose deletion grace period has ended (system scope, cron)
    where: { status: "pending_deletion", deletionPurgeAt: { lte: now } },
    select: { id: true },
    orderBy: { deletionPurgeAt: "asc" },
    take: 1,
  }));
  const purged: string[] = [];
  const failed: string[] = [];
  for (const t of due) {
    const r = await purgeWorkspace(t.id, { now }).catch((e) => ({ ok: false, tenantId: t.id, steps: [{ step: "failed", ok: false, error: String(e?.message ?? e) }] }));
    (r.ok ? purged : failed).push(t.id);
  }
  return { purged, failed };
}

const DAY_MS = 86_400_000;

/** How long a purged workspace's audit trail is kept: CURF_AUDIT_AFTER_PURGE_DAYS (default 365, at least 30). */
export function auditAfterPurgeDays(): number {
  const n = Math.floor(Number(process.env.CURF_AUDIT_AFTER_PURGE_DAYS ?? 365));
  return Number.isFinite(n) ? Math.max(30, n) : 365;
}

/**
 * Remove the audit rows of workspaces that were purged long enough ago. The database function refuses to run while the
 * workspace still exists, so this can never touch a live workspace's trail.
 */
export async function purgeAuditAfterRetention(now: Date = new Date()): Promise<{ workspaces: number; rows: number }> {
  const cutoff = new Date(now.getTime() - auditAfterPurgeDays() * DAY_MS);
  return withSystemDbContext(async () => {
    // nosemgrep: prisma-must-include-tenant -- platform-level deletion records, read by the cron sweep (system scope)
    const due = await prisma.workspaceDeletion.findMany({
      where: { status: "purged", auditPurgedAt: null, purgedAt: { lte: cutoff } },
      select: { id: true, targetTenantId: true },
      take: 20,
    });
    let rows = 0;
    for (const d of due) {
      const r = await prisma.$queryRaw<Array<{ n: bigint | number }>>`SELECT curf_audit_purge_tenant(${d.targetTenantId}) AS n`;
      rows += Number(r[0]?.n ?? 0);
      await prisma.workspaceDeletion.update({ where: { id: d.id }, data: { auditPurgedAt: now } });
    }
    return { workspaces: due.length, rows };
  });
}
