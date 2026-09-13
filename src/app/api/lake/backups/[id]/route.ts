/**
 * /api/lake/backups/[id]
 *   POST { action: "restore" } — atomic restore over the live lake
 *   DELETE                     — drop snapshot row + on-disk file
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import fs from "node:fs";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { restoreBackup, backupPath } from "@/lib/lake/backup";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ActionSchema = z.object({ action: z.literal("restore") });

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => ({}));
  const parsed = ActionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid action" }, { status: 400 });

  // Verify the backup row belongs to this tenant before doing anything.
  const row = await prisma.lakeBackup.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
  });
  if (!row) return NextResponse.json({ error: "Backup not found" }, { status: 404 });

  try {
    const result = await restoreBackup({
      tenantId: user.tenantId,
      backupId: params.id,
      createdById: user.id,
    });
    recordAudit({
      user, kind: "lake.backup.restore", target: params.id, req,
      meta: { preRestoreBackupId: result.preRestoreBackupId },
    });
    return NextResponse.json({ ...result, ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Restore failed" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const row = await prisma.lakeBackup.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
  });
  if (!row) return NextResponse.json({ error: "Backup not found" }, { status: 404 });

  // File first so a failure leaves a stale catalog row (recoverable by
  // a re-snapshot) rather than a phantom file (silently consuming disk).
  const f = backupPath(user.tenantId, row.id);
  try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* best effort */ }
  await prisma.lakeBackup.delete({ where: { id: row.id } });

  recordAudit({ user, kind: "lake.backup.delete", target: row.id, req, meta: {} });
  return NextResponse.json({ ok: true });
}
