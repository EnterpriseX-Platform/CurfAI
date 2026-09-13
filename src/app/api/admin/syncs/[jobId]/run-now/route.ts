/**
 * POST /api/admin/syncs/[jobId]/run-now
 *
 * Out-of-cycle sync trigger. Sets nextRunAt = now and clears any stale
 * lease so the next cron tick (or an immediate dispatchDueSyncs call)
 * picks the job up. Admin-only, tenant-scoped — we verify the SyncJob
 * belongs to this tenant via its SyncConnection, not via the URL.
 *
 * Does NOT inline the dispatch — that would make the response wait on
 * the connector, which for a cold-loading Postgres table is minutes.
 * The user just gets back "queued"; they refresh the syncs page to
 * watch progress.
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

  // Tenant-check via the join. The SyncJob row has no tenantId itself
  // (it lives on SyncConnection) — we must look that up.
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
    data: { nextRunAt: new Date(), leasedBy: null, leasedUntil: null },
  });

  recordAudit({
    user, kind: "sync.run_now", target: job.id, req,
    meta: { connectionId: job.connectionId },
  });

  return NextResponse.json({ ok: true, jobId: job.id, queuedAt: new Date().toISOString() });
}
