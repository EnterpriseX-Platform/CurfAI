/**
 * DELETE /api/admin/users/[id]/membership — remove a member who has already
 * accepted from THIS workspace (offboarding).
 *
 * Until now there was no way to do this outside SCIM: DELETE on the parent
 * route only revokes pending invites (409 for anyone with a password), and
 * the Users page had no button, so an admin could at most demote a departed
 * colleague to viewer — still able to read every report. Kept as its own
 * endpoint so the "revoke invite" button can never remove someone who has
 * just accepted.
 *
 * The account itself stays: it may belong to other workspaces, and it can
 * be invited back. Sessions that are still open lose this workspace at
 * their next role re-check (lib/auth.ts jwt()). Two things they leave
 * behind are handled in the same transaction:
 *   - their owner-only items (data sources, dashboards, on-screen displays,
 *     lake tables) move to the admin removing them, still private. Owner-
 *     only has no admin bypass, so they would otherwise be visible to
 *     nobody, for good.
 *   - every API key they minted here is revoked — MCP connector tokens
 *     included, which are API keys in their name. A key is checked on every
 *     request, so it stops working at once.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { ee } from "@/ee";

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;

  if (params.id === u.id) {
    return NextResponse.json({ error: "You can't remove yourself from the workspace." }, { status: 400 });
  }

  const target = await prisma.membership.findUnique({
    where: { userId_tenantId: { userId: params.id, tenantId: u.tenantId } },
    include: { user: { select: { id: true, email: true, passwordHash: true } } },
  });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!target.user.passwordHash) {
    return NextResponse.json({ error: "This invite hasn't been accepted yet — revoke the invite instead." }, { status: 409 });
  }
  // The caller is an admin, but possibly a virtual one (a Platform Admin
  // overseeing this workspace without a Membership of their own), so the
  // target can be the only real admin left.
  if (target.role === "admin") {
    const admins = await prisma.membership.count({ where: { tenantId: u.tenantId, role: "admin" } });
    if (admins <= 1) {
      return NextResponse.json({ error: "This is the workspace's last admin. Make someone else an admin first." }, { status: 409 });
    }
  }

  const handover = await prisma.$transaction(async (tx) => {
    const owned = { tenantId: u.tenantId, ownerUserId: target.user.id };
    const toAdmin = { ownerUserId: u.id };
    const moved = {
      dataSources: (await tx.dataSource.updateMany({ where: owned, data: toAdmin })).count,
      dashboards: (await tx.dashboard.updateMany({ where: owned, data: toAdmin })).count,
      screens: (await tx.onScreenDisplay.updateMany({ where: owned, data: toAdmin })).count,
      lakeTables: (await tx.lakeTable.updateMany({ where: owned, data: toAdmin })).count,
    };
    const revokedKeys = (await tx.apiKey.updateMany({
      where: { tenantId: u.tenantId, createdById: target.user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    })).count;
    await tx.membership.delete({ where: { userId_tenantId: { userId: target.user.id, tenantId: u.tenantId } } });
    return { moved, revokedKeys };
  });
  // Seat billing follows the membership change; best-effort, the hourly
  // reconcile in the paid cron covers a missed call.
  void ee.billing?.syncSeats(u.tenantId).catch(() => null);

  recordAudit({
    user: u, kind: "user.remove", target: target.user.id, req,
    meta: { email: target.user.email, role: target.role, movedToAdmin: handover.moved, revokedApiKeys: handover.revokedKeys },
  });
  const movedItems = Object.values(handover.moved).reduce((n, c) => n + c, 0);
  return NextResponse.json({ ok: true, movedItems, moved: handover.moved, revokedKeys: handover.revokedKeys });
}
