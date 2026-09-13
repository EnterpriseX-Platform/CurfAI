/**
 * POST /api/admin/syncs/[jobId]/pause
 *
 * Body: { enabled: boolean }
 *
 * Toggle a sync job on or off. Pausing leaves the cursor + history
 * untouched — re-enabling resumes from the last cursor position so no
 * data is lost during a pause window. Admin-only, tenant-scoped.
 *
 * One toggle, two semantics:
 *   { enabled: false }  →  scheduler stops picking the job up
 *   { enabled: true }   →  scheduler resumes; nextRunAt is left alone
 *                          (i.e. the job fires on its existing cron,
 *                          not immediately — use run-now if you want
 *                          to catch up the missed window)
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: { jobId: string } }) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => ({}));
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "Body must be { enabled: boolean }" }, { status: 400 });
  }

  const job = await prisma.syncJob.findUnique({
    where: { id: params.jobId },
    select: { id: true, connectionId: true },
  });
  if (!job) return NextResponse.json({ error: "Sync job not found" }, { status: 404 });
  const conn = await prisma.syncConnection.findUnique({
    where: { id: job.connectionId },
    select: { tenantId: true },
  });
  if (!conn || conn.tenantId !== user.tenantId) {
    return NextResponse.json({ error: "Sync job not found" }, { status: 404 });
  }

  await prisma.syncJob.update({
    where: { id: job.id },
    data: { enabled: body.enabled },
  });

  recordAudit({
    user, kind: body.enabled ? "sync.resumed" : "sync.paused", target: job.id, req,
    meta: { connectionId: job.connectionId },
  });

  return NextResponse.json({ ok: true, jobId: job.id, enabled: body.enabled });
}
