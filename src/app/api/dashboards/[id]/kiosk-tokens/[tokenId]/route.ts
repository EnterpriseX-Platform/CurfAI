/**
 * Dashboard kiosk-token revoke endpoint.
 *
 * DELETE /api/dashboards/[id]/kiosk-tokens/[tokenId]
 *   Soft-revokes the token by stamping revokedAt. The row stays in the
 *   table so the audit trail is preserved and so a subsequent kiosk
 *   request with the revoked token logs a denial rather than a "no such
 *   token" 404 (which would look like an admin typo).
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; tokenId: string } },
) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const tok = await prisma.dashboardKioskToken.findFirst({
    where: { id: params.tokenId, dashboardId: params.id, tenantId: user.tenantId },
    select: { id: true, label: true, revokedAt: true },
  });
  if (!tok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (tok.revokedAt) {
    // Idempotent — re-revoking a revoked token is a no-op + 200, so the
    // manage UI doesn't need to special-case race conditions.
    return NextResponse.json({ ok: true, alreadyRevoked: true });
  }
  await prisma.dashboardKioskToken.update({
    where: { id: params.tokenId },
    data: { revokedAt: new Date() },
  });
  recordAudit({
    user, kind: "dashboard.kiosk_token.revoke", target: params.tokenId, req,
    meta: { dashboardId: params.id, label: tok.label ?? null },
  });
  return NextResponse.json({ ok: true });
}
