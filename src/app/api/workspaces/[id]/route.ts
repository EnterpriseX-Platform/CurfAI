/**
 * DELETE /api/workspaces/[id] — ask for a workspace (tenant) to be deleted.
 *
 * This no longer deletes anything at once. It closes the workspace (status "pending_deletion", closed to everyone like a
 * suspension), makes a copy of its data for the admins to download, and starts a grace period (30 days by default,
 * CURF_DELETION_GRACE_DAYS). An admin can cancel in that time (POST /api/workspaces/[id]/deletion/cancel); when it ends
 * the cron tick purges the rows, the files on disk, the backups and the certificate (lib/lifecycle/purge.ts).
 *
 * Guardrails (all destructive-action, not just "is this an admin"):
 *  - Caller must hold a REAL (non-virtual — see CurfMembership.isVirtual)
 *    admin membership in the target tenant specifically, not merely be an
 *    admin of whichever tenant happens to be active in their session, and
 *    not a Platform Admin viewing via org oversight who never actually
 *    joined it.
 *  - Caller must have at least one other workspace left — deleting your
 *    only membership would leave the account with nowhere to land.
 *  - Caller must echo back the exact slug in the request body (type-to-
 *    confirm), so this can't be triggered by a stray click.
 *  - Blocked if the tenant has an active/trialing/past-due paid Stripe
 *    subscription (checked in lib/lifecycle/deletion.ts) — cancel billing
 *    first, or a customer keeps getting charged for a closed workspace.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { findWorkspaceById } from "@/lib/workspaceDirectory";
import { LifecycleError, scheduleDeletion } from "@/lib/lifecycle/deletion";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.viaApiKey) {
    return NextResponse.json({ error: "Session required to delete a workspace" }, { status: 403 });
  }

  const targetId = params.id;
  const realMemberships = (user.memberships ?? []).filter((m) => !m.isVirtual);
  const membership = realMemberships.find((m) => m.tenantId === targetId);
  if (!membership || membership.role !== "admin") {
    return NextResponse.json({ error: "Only an admin of this workspace can delete it" }, { status: 403 });
  }
  if (membership.tenantStatus === "pending_deletion") {
    return NextResponse.json({ error: "This workspace is already scheduled for deletion" }, { status: 409 });
  }
  if (realMemberships.filter((m) => m.tenantStatus !== "pending_deletion").length <= 1) {
    return NextResponse.json({ error: "You can't delete your only workspace" }, { status: 400 });
  }

  // The target is usually not the workspace this request is bound to, so its row is read in the system scope — the
  // admin-membership check above is the authorization (lib/workspaceDirectory.ts).
  const tenant = await findWorkspaceById(targetId, { name: true, slug: true });
  if (!tenant) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body.confirmSlug !== "string" || body.confirmSlug !== tenant.slug) {
    return NextResponse.json({ error: "Confirmation text did not match the workspace slug" }, { status: 400 });
  }

  try {
    const r = await scheduleDeletion(targetId, { email: user.email, id: user.id }, { via: "admin", reason: typeof body.reason === "string" ? body.reason.slice(0, 500) : undefined });
    console.warn(`[workspace-delete] tenant=${targetId} slug=${tenant.slug} scheduledBy=${user.email} purgeAt=${r.purgeAt.toISOString()}`);
    return NextResponse.json({ ok: true, purgeAt: r.purgeAt.toISOString(), exportId: r.exportId });
  } catch (e) {
    if (e instanceof LifecycleError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
