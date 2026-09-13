/**
 * /api/lake/backups
 *   GET    — list this tenant's snapshots (descending by createdAt)
 *   POST   — manual snapshot ("Snapshot now" button on the admin page)
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { snapshotTenant } from "@/lib/lake/backup";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const items = await prisma.lakeBackup.findMany({
    where: { tenantId: user.tenantId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return NextResponse.json({ items });
}

export async function POST(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const result = await snapshotTenant({
    tenantId: user.tenantId,
    kind: "manual",
    createdById: user.id,
  });
  if (result.skipped) {
    return NextResponse.json({ error: `Snapshot skipped: ${result.skipped}` }, { status: 400 });
  }
  recordAudit({ user, kind: "lake.backup.manual", target: result.backupId, req, meta: { sizeBytes: result.sizeBytes, tableCount: result.tableCount } });
  return NextResponse.json({ ok: true, backup: result });
}
