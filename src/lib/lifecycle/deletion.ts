/**
 * Deleting a workspace: a request, a grace period, then a purge (lib/lifecycle/purge.ts).
 *
 * Deleting used to be one irreversible click that removed the rows and left everything on disk. Now a request only
 * closes the workspace (status "pending_deletion", closed to everyone like a suspension — lib/tenantStatus.ts) and
 * starts a grace period, 30 days by default, during which an admin or an operator can change their mind. Nothing is
 * removed until the grace period ends and the purge runs from the cron tick.
 *
 * Rules enforced here, not in the routes that call it (an admin's request, an operator's request on a customer's
 * behalf and a person's erasure all come through):
 *   - a workspace with a running paid subscription can't be scheduled — billing would carry on for nothing;
 *   - the audit row is written first and awaited: if it can't be written, nothing changes;
 *   - a copy of the workspace's data is exported automatically at request time and kept until the purge, so the
 *     customer can still collect their data after asking for deletion;
 *   - cancelling puts the workspace back to what it was before (a suspended workspace stays suspended).
 */
import { prisma } from "@/lib/db";
import { withSystemDbContext } from "@/lib/dbContext";
import { persistAudit } from "@/lib/audit";
import { forgetTenantStatus } from "@/lib/tenantGuard";
import { subscriptionKeepsPaidTier } from "@/lib/plans";

export const DEFAULT_GRACE_DAYS = 30;
const DAY_MS = 86_400_000;

/** How long a requested deletion waits: CURF_DELETION_GRACE_DAYS (1–365, default 30; 0 is allowed outside production, for tests). */
export function graceDays(): number {
  const raw = process.env.CURF_DELETION_GRACE_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_GRACE_DAYS;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_GRACE_DAYS;
  const min = process.env.NODE_ENV === "production" ? 1 : 0;
  return Math.min(365, Math.max(min, n));
}

export function purgeDate(from: Date, days: number = graceDays()): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

export class LifecycleError extends Error {
  constructor(message: string, public status: 400 | 403 | 404 | 409 = 400) { super(message); }
}

export type Actor = { email: string; id?: string };
export type DeletionVia = "admin" | "operator" | "erasure";

export type ScheduledDeletion = { purgeAt: Date; exportId: string | null };

/**
 * Close a workspace and schedule it for deletion. Who may ask is decided by the caller (a real admin of the
 * workspace, an operator, or the person being erased); this does the rest.
 */
export async function scheduleDeletion(
  tenantId: string,
  by: Actor,
  opts: { via: DeletionVia; reason?: string; now?: Date } = { via: "admin" },
): Promise<ScheduledDeletion> {
  const now = opts.now ?? new Date();
  const purgeAt = purgeDate(now);

  await withSystemDbContext(async () => {
    const t = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, slug: true, status: true, stripeSubscriptionId: true, stripeStatus: true },
    });
    if (!t) throw new LifecycleError("Workspace not found", 404);
    if (t.status === "pending_deletion") throw new LifecycleError("This workspace is already scheduled for deletion", 409);
    if (t.stripeSubscriptionId && subscriptionKeepsPaidTier(t.stripeStatus)) {
      throw new LifecycleError("This workspace has an active subscription. Cancel billing (Admin → Billing) before deleting it.", 409);
    }

    // Written first and awaited: if the trail can't be kept, the workspace is left alone.
    await persistAudit({
      tenantId, userId: by.id || undefined, userEmail: by.email, kind: "tenant.delete.schedule", target: tenantId,
      meta: { via: opts.via, reason: opts.reason ?? null, workspaceName: t.name, slug: t.slug, purgeAt: purgeAt.toISOString(), graceDays: graceDays() },
    });

    await prisma.$transaction([
      prisma.tenant.update({
        where: { id: tenantId },
        data: {
          status: "pending_deletion",
          deletionRequestedBy: by.email,
          deletionRequestedAt: now,
          deletionPurgeAt: purgeAt,
          deletionPriorStatus: t.status === "suspended" ? "suspended" : "active",
        },
      }),
      prisma.workspaceDeletion.upsert({
        where: { targetTenantId: tenantId },
        create: { targetTenantId: tenantId, slug: t.slug, name: t.name, requestedBy: by.email, requestedAt: now, purgeAt, status: "scheduled" },
        update: {
          slug: t.slug, name: t.name, requestedBy: by.email, requestedAt: now, purgeAt, status: "scheduled",
          cancelledBy: null, cancelledAt: null, purgedAt: null,
        },
      }),
    ]);
    forgetTenantStatus(tenantId);
  });

  // A copy of the data, made now and kept until the purge. A failure here must not undo the request: it is logged, and
  // the admin can still ask for an export from the workspace's own page for as long as it is open to them.
  let exportId: string | null = null;
  try {
    const { createWorkspaceExport } = await import("./export");
    exportId = (await createWorkspaceExport({ tenantId, requestedBy: by.email, reason: "before_deletion", keepUntil: purgeAt })).id;
  } catch (e: any) {
    console.error("[lifecycle] could not start the export made before deletion:", e?.message ?? e);
  }
  return { purgeAt, exportId };
}

/** Withdraw a requested deletion: the workspace goes back to what it was before, and nothing was removed. */
export async function cancelDeletion(tenantId: string, by: Actor, opts: { reason?: string; now?: Date } = {}): Promise<{ restoredTo: "active" | "suspended" }> {
  const now = opts.now ?? new Date();
  return withSystemDbContext(async () => {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { status: true, deletionPriorStatus: true } });
    if (!t) throw new LifecycleError("Workspace not found", 404);
    if (t.status !== "pending_deletion") throw new LifecycleError("This workspace is not scheduled for deletion", 409);
    const restoredTo = t.deletionPriorStatus === "suspended" ? "suspended" : "active";

    await persistAudit({
      tenantId, userId: by.id || undefined, userEmail: by.email, kind: "tenant.delete.cancel", target: tenantId,
      meta: { reason: opts.reason ?? null, restoredTo },
    });
    await prisma.$transaction([
      prisma.tenant.update({
        where: { id: tenantId },
        data: {
          status: restoredTo,
          deletionRequestedBy: null, deletionRequestedAt: null, deletionPurgeAt: null, deletionPriorStatus: null,
          // A workspace that goes back to suspended keeps the reason it had; one that goes back to active has none.
          ...(restoredTo === "active" ? { suspendedAt: null, suspendedReason: null } : {}),
        },
      }),
      prisma.workspaceDeletion.updateMany({
        where: { targetTenantId: tenantId, status: "scheduled" },
        data: { status: "cancelled", cancelledBy: by.email, cancelledAt: now },
      }),
    ]);
    forgetTenantStatus(tenantId);
    return { restoredTo };
  });
}

/** Whole days left before the purge, never negative. */
export function daysUntil(purgeAt: Date | null | undefined, now: Date = new Date()): number | null {
  if (!purgeAt) return null;
  return Math.max(0, Math.ceil((purgeAt.getTime() - now.getTime()) / DAY_MS));
}
