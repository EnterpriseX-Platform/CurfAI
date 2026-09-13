import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { mintAndSendInvite } from "@/lib/invites";

/**
 * POST /api/admin/users/[id]/resend-invite
 *
 * Re-mints a 7-day accept token for a user who hasn't yet set a password,
 * invalidates any prior unused tokens for that user, and dispatches the
 * invite email again. Returns the accept URL when SMTP is missing so the
 * admin can copy + paste it through their own channel.
 *
 * Refuses to resend for users who have already accepted (passwordHash set).
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const u = await requireAdmin(req);
  if (u instanceof NextResponse) return u;

  const membership = await prisma.membership.findUnique({
    where: { userId_tenantId: { userId: params.id, tenantId: u.tenantId } },
    include: { user: { select: { id: true, email: true, name: true, passwordHash: true } } },
  });
  if (!membership) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const target = { ...membership.user, role: membership.role };
  if (target.passwordHash) {
    return NextResponse.json(
      { error: "User has already accepted their invite. Use password reset instead." },
      { status: 409 },
    );
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: u.tenantId },
    select: { name: true },
  });

  const origin = new URL(req.url).origin;
  const minted = await mintAndSendInvite({
    tenantId: u.tenantId,
    tenantName: tenant?.name ?? "Curf",
    inviterName: u.name ?? u.email,
    user: target,
    origin,
    invalidatePrevious: true,
  });

  recordAudit({
    user: u, kind: "user.invite.resend", target: target.id, req,
    meta: {
      email: target.email,
      emailStatus: minted.emailStatus,
      expiresAt: minted.expiresAt.toISOString(),
    },
  });

  return NextResponse.json({
    id: target.id,
    email: target.email,
    emailStatus: minted.emailStatus,
    acceptUrl: minted.emailStatus === "sent" ? null : minted.acceptUrl,
    expiresAt: minted.expiresAt.toISOString(),
  });
}
