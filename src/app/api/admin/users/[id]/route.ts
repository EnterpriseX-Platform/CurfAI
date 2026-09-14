import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { ee } from "@/ee";

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;
  const body = await req.json().catch(() => null) as { roles?: string[] } | null;
  if (!body || !Array.isArray(body.roles)) {
    return NextResponse.json({ error: "roles[] required" }, { status: 400 });
  }
  // rolesJson (custom roles, distinct from admin/editor/viewer) is
  // per-workspace — it lives on the Membership for THIS tenant now.
  const target = await prisma.membership.findUnique({
    where: { userId_tenantId: { userId: params.id, tenantId: u.tenantId } },
    include: { user: { select: { email: true } } },
  });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const clean = body.roles.filter((r) => typeof r === "string").map((r) => r.trim()).filter(Boolean);
  const dedup = Array.from(new Set(clean));
  await prisma.membership.update({
    where: { userId_tenantId: { userId: params.id, tenantId: u.tenantId } },
    data: { rolesJson: JSON.stringify(dedup) },
  });
  recordAudit({
    user: u, kind: "role.assign", target: params.id, req,
    meta: { targetEmail: target.user.email, roles: dedup },
  });
  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/admin/users/[id]
 *
 * Revoke a pending invite to THIS workspace: drops any unused
 * PasswordResetTokens minted for it, then removes the Membership. Refuses
 * for users who have already accepted (passwordHash set) - a different
 * "remove user" endpoint should handle that, with the heavier confirm UI
 * it deserves.
 *
 * The global User row is only deleted when this was the account's last
 * membership anywhere AND it still has no password — i.e. a genuinely
 * orphaned invite, not a person who's pending here but already active in
 * another workspace.
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;

  // Don't let an admin revoke themselves into a corner.
  if (params.id === u.id) {
    return NextResponse.json({ error: "You can't revoke your own account this way." }, { status: 400 });
  }

  const target = await prisma.membership.findUnique({
    where: { userId_tenantId: { userId: params.id, tenantId: u.tenantId } },
    include: { user: { select: { id: true, email: true, passwordHash: true } } },
  });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (target.user.passwordHash) {
    return NextResponse.json(
      { error: "User has already accepted. Revoke is for pending invites only." },
      { status: 409 },
    );
  }

  // Drop only the token(s) minted for THIS workspace's invite — an unused
  // pending invite to a different workspace must survive this call.
  await prisma.passwordResetToken.deleteMany({
    where: { userId: target.user.id, tenantId: u.tenantId },
  });
  await prisma.membership.delete({ where: { userId_tenantId: { userId: target.user.id, tenantId: u.tenantId } } });
  // Seat billing follows the membership change; best-effort, the hourly
  // reconcile in the paid cron covers a missed call.
  void ee.billing?.syncSeats(u.tenantId).catch(() => null);

  const remaining = await prisma.membership.count({ where: { userId: target.user.id } });
  if (remaining === 0) {
    // No workspace left, still no password set — this account never had
    // anywhere to sign in. Clean it up rather than leaving a dangling row.
    await prisma.user.delete({ where: { id: target.user.id } }).catch(() => null);
  }

  recordAudit({
    user: u, kind: "user.invite.revoke", target: target.user.id, req,
    meta: { email: target.user.email },
  });

  return NextResponse.json({ ok: true });
}
