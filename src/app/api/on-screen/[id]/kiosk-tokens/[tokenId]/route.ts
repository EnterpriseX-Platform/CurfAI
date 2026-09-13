/**
 * OnScreenDisplay kiosk-token revoke endpoint. Mirrors
 * /api/dashboards/[id]/kiosk-tokens/[tokenId] — soft-revoke, idempotent.
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

  const tok = await prisma.onScreenDisplayKioskToken.findFirst({
    where: { id: params.tokenId, onScreenId: params.id, tenantId: user.tenantId },
    select: { id: true, label: true, revokedAt: true },
  });
  if (!tok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (tok.revokedAt) {
    return NextResponse.json({ ok: true, alreadyRevoked: true });
  }
  await prisma.onScreenDisplayKioskToken.update({
    where: { id: params.tokenId },
    data: { revokedAt: new Date() },
  });
  recordAudit({
    user, kind: "onScreen.kiosk_token.revoke", target: params.tokenId, req,
    meta: { onScreenId: params.id, label: tok.label ?? null },
  });
  return NextResponse.json({ ok: true });
}
