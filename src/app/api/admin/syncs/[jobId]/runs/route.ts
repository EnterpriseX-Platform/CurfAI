/**
 * GET /api/admin/syncs/[jobId]/runs?limit=50
 *
 * Paginated SyncRun history for the log viewer on the syncs page.
 * Returns newest-first, capped at limit (default 50, max 200). Each
 * row carries the bits the UI needs for the timeline: start/finish,
 * status, row counts, error message.
 *
 * No cursor-pagination yet — 200 rows covers ~a week of hourly syncs
 * which is plenty for the "view log" expander. If a pilot wants
 * deeper history we can layer .skip on top.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: { jobId: string } }) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  // Tenant check (same pattern as the other admin sync endpoints).
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

  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 50;

  const rows = await prisma.syncRun.findMany({
    where: { jobId: job.id },
    orderBy: { startedAt: "desc" },
    take: limit,
    select: {
      id: true,
      startedAt: true,
      finishedAt: true,
      status: true,
      rowsRead: true,
      rowsWritten: true,
      errorMessage: true,
    },
  });

  return NextResponse.json({
    runs: rows.map((r: any) => ({
      id: r.id,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      status: r.status,
      rowsRead: r.rowsRead,
      rowsWritten: r.rowsWritten,
      errorMessage: r.errorMessage,
    })),
  });
}
