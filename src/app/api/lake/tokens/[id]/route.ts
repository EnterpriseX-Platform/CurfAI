/**
 * /api/lake/tokens/[id] — DELETE = revoke (soft delete via revokedAt).
 *
 * We don't hard-delete so the audit log retains the token's identity
 * even after it's no longer usable.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const row = await prisma.lakeIngestToken.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.lakeIngestToken.update({
    where: { id: row.id },
    data: { revokedAt: new Date() },
  });
  recordAudit({ user, kind: "lake.token.revoke", target: row.id, req, meta: { label: row.label } });
  return NextResponse.json({ ok: true });
}
