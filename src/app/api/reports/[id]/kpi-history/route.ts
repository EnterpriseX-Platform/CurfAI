/**
 * GET /api/reports/:id/kpi-history?blockId=<kpi block id>&days=14
 *
 * The time-travel series behind a KPI card's "Replay": one point per
 * calendar day (UTC), taken from the ReportRun snapshots the viewer records
 * on every load (see reports/[id]/page.tsx). Nothing is executed here — it
 * only re-reads datasets that were already produced and proof-stamped, so
 * every point carries the hashes / run time / row count of the run it came
 * from, and `runId` links straight into the existing report-level replay
 * (`/reports/:id?replay=<runId>`).
 *
 * Returns { blockId, days, points: [{ runId, at, value, compare, dataHash,
 * queryHash, rowCount, runAt }] } oldest → newest. Internal, read-only; not
 * part of /api/v1.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser, requireReportInScope, reportWhere } from "@/lib/auth";
import { ReportSchema } from "@/lib/reporting/schema";
import { computeKpiValue, pickKpiCompare } from "@/lib/reporting/kpi";
import type { ProvenanceMap } from "@/lib/reporting/provenance";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_DAYS = 90;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;

  const url = new URL(req.url);
  const blockId = url.searchParams.get("blockId") ?? "";
  const daysRaw = Number(url.searchParams.get("days") ?? 14);
  const days = Number.isFinite(daysRaw) ? Math.min(MAX_DAYS, Math.max(1, Math.floor(daysRaw))) : 14;
  if (!blockId) return NextResponse.json({ error: "blockId is required" }, { status: 400 });

  const row = await prisma.report.findFirst({
    where: { id: params.id, ...reportWhere(user) },
    select: { id: true, tenantId: true, definition: true },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let report: ReturnType<typeof ReportSchema.parse>;
  try {
    report = ReportSchema.parse(JSON.parse(row.definition));
  } catch (e: any) {
    return NextResponse.json({ error: "Invalid report definition", detail: e?.message }, { status: 422 });
  }
  const block = report.pages.flatMap((p) => p.blocks).find((b) => b.id === blockId);
  if (!block || block.type !== "kpi") return NextResponse.json({ error: "KPI block not found" }, { status: 404 });
  const cfg = block.config;

  // Cheap pass first: ids + timestamps only, then keep the latest run of
  // each UTC day so a report viewed forty times on Tuesday is one point.
  const since = new Date(Date.now() - days * 86_400_000);
  const runs = await prisma.reportRun.findMany({
    where: {
      tenantId: user.tenantId,
      reportId: row.id,
      status: "completed",
      format: "html",
      dataset: { not: null },
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true },
    take: 2000,
  });
  const latestPerDay = new Map<string, { id: string; createdAt: Date }>();
  for (const r of runs) {
    const day = r.createdAt.toISOString().slice(0, 10);
    if (!latestPerDay.has(day)) latestPerDay.set(day, r);
  }
  const chosenIds = Array.from(latestPerDay.values()).map((r) => r.id);
  if (chosenIds.length === 0) return NextResponse.json({ blockId, days, points: [] });

  // Only now load the (up to 2 MB each) snapshots, for the handful of runs kept.
  const full = await prisma.reportRun.findMany({
    where: { id: { in: chosenIds }, tenantId: user.tenantId, reportId: row.id },
    select: { id: true, createdAt: true, dataset: true, provenance: true },
    orderBy: { createdAt: "asc" },
  });

  const points = full.flatMap((run) => {
    let dataset: Record<string, Array<Record<string, unknown>>> = {};
    let provenance: ProvenanceMap = {};
    try { dataset = JSON.parse(run.dataset ?? "{}"); } catch { return []; }
    try { provenance = JSON.parse(run.provenance ?? "{}"); } catch { provenance = {}; }
    const rows = Array.isArray(dataset[cfg.queryId]) ? dataset[cfg.queryId] : [];
    const value = computeKpiValue(cfg, rows);
    if (!Number.isFinite(value)) return [];
    const proof = provenance[cfg.queryId];
    const at = run.createdAt.toISOString();
    return [{
      runId: run.id,
      at,
      value,
      compare: pickKpiCompare(rows, cfg.compareField) ?? null,
      dataHash: proof?.dataHash ?? null,
      queryHash: proof?.queryHash ?? null,
      rowCount: proof?.rowCount ?? rows.length,
      runAt: proof?.runAt ?? at,
    }];
  });

  return NextResponse.json({ blockId, days, points });
}
