/**
 * /api/reports/[id]/slow-stats — surface "is this report slow?" stats for
 * the SlowQueryBanner mounted on the viewer.
 *
 * Returns the count + max + avg duration of completed `format=html` runs
 * over the last 7 days. The banner only appears when avg > SLOW_QUERY_MS,
 * which keeps it from cluttering normal reports.
 *
 * Lightweight by design — Prisma aggregate, no joins. Cached at the
 * viewer level via SWR-style first-load fetch.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser, requireReportInScope } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SLOW_QUERY_MS = 2000;
const WINDOW_MS = 7 * 86_400_000;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;

  // Visibility check: only return stats for reports in the user's tenant.
  const exists = await prisma.report.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
    select: { id: true, name: true },
  });
  if (!exists) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const runs = await prisma.reportRun.findMany({
    where: {
      reportId: params.id,
      tenantId: user.tenantId,
      status: "completed",
      format: "html",
      createdAt: { gte: new Date(Date.now() - WINDOW_MS) },
      durationMs: { gt: 0 },
    },
    select: { durationMs: true },
    take: 500,
  });

  if (runs.length === 0) {
    return NextResponse.json({ slow: false, runCount: 0 });
  }

  let total = 0;
  let max = 0;
  let slowCount = 0;
  for (const r of runs) {
    const d = r.durationMs ?? 0;
    total += d;
    if (d > max) max = d;
    if (d > SLOW_QUERY_MS) slowCount++;
  }
  const avg = Math.round(total / runs.length);

  return NextResponse.json({
    slow: avg > SLOW_QUERY_MS,
    runCount: runs.length,
    slowCount,
    avgMs: avg,
    maxMs: max,
    threshold: SLOW_QUERY_MS,
    reportName: exists.name,
  });
}
