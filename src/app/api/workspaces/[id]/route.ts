/**
 * DELETE /api/workspaces/[id] — permanently delete a workspace (tenant).
 *
 * Every relation back to Tenant in prisma/schema.prisma is declared with
 * `onDelete: Cascade`, so a plain `prisma.tenant.delete()` correctly removes
 * every report, dashboard, data source, membership, etc. that belonged to
 * it — there is no separate manual cleanup pass to keep in sync with the
 * schema.
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
 *  - Blocked outright if the tenant has an active/trialing/past-due paid
 *    Stripe subscription — cancel billing first, or a customer keeps
 *    getting charged for a workspace that no longer exists.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BLOCKING_STRIPE_STATUSES = new Set(["active", "trialing", "past_due"]);

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
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
  if (realMemberships.length <= 1) {
    return NextResponse.json({ error: "You can't delete your only workspace" }, { status: 400 });
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: targetId } });
  if (!tenant) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body.confirmSlug !== "string" || body.confirmSlug !== tenant.slug) {
    return NextResponse.json({ error: "Confirmation text did not match the workspace slug" }, { status: 400 });
  }

  if (tenant.stripeSubscriptionId && BLOCKING_STRIPE_STATUSES.has(tenant.stripeStatus ?? "")) {
    return NextResponse.json(
      { error: "This workspace has an active subscription. Cancel billing (Admin → Billing) before deleting it." },
      { status: 400 },
    );
  }

  // Best-effort: this row lives under the tenant being deleted, so it
  // cascades away with everything else a moment later — the durable trail
  // is the server log line below, which survives the DB cascade.
  recordAudit({
    user, kind: "tenant.delete", target: targetId, req,
    meta: { workspaceName: tenant.name, slug: tenant.slug },
  });
  console.warn(
    `[workspace-delete] tenant=${targetId} slug=${tenant.slug} name=${JSON.stringify(tenant.name)} ` +
    `deletedBy=${user.email} at=${new Date().toISOString()}`,
  );

  await prisma.tenant.delete({ where: { id: targetId } });

  return NextResponse.json({ ok: true });
}
