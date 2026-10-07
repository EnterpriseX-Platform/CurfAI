/**
 * Shared core for "run a report and return its dataset" — used by both
 * POST /api/reports/[id]/run (session-based viewer) and
 * GET /api/v1/reports/[id]/data (public v1 API, session or Bearer key).
 *
 * Before this existed, the two routes independently reimplemented the same
 * fetch → parse-params → run → record-history sequence, and had quietly
 * drifted: v1 had no rate limit and never wrote ReportRun history rows (so
 * /history replay silently missed any run triggered via the public API),
 * while the internal route never passed `viewer` into runReportWithProof
 * (so its per-data-source visibility check, canSeeDataSource(), was
 * skipped there but not in v1). This module is the one place that logic
 * lives now — each caller only owns its own response envelope.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ReportSchema, type Report } from "@/lib/reporting/schema";
import { runReportWithProof, type RunResult, type RunViewer } from "@/lib/reporting/runner";
import { visibleReport } from "@/lib/reporting/visibleReport";
import { snapshotOf } from "@/lib/reporting/runSnapshot";
import { parseParams } from "@/lib/reporting/params";
import { getUserRoles, reportWhere, type CurfSessionUser } from "@/lib/auth";
import { ensureLimit } from "@/lib/rateLimit";
import { runOutcome } from "@/lib/reporting/queryRunState";

export type RunReportForApiResult =
  | {
      ok: true;
      reportId: string;
      paramsApplied: Record<string, unknown>;
      dataset: RunResult["dataset"];
      provenance: RunResult["provenance"];
    }
  | { ok: false; response: NextResponse };

/**
 * Rate-limited per tenant: 60 runs/min, shared across every entry point
 * that calls this helper — report execution hits the warehouse and
 * allocates memory proportional to row count, so a tight loop from any
 * client (browser or API key) would DoS the DB.
 */
export async function runReportForApi(
  user: CurfSessionUser,
  reportId: string,
  url: URL,
  opts: { cacheBust?: boolean } = {},
): Promise<RunReportForApiResult> {
  const limited = ensureLimit("run", `t:${user.tenantId}`, 60, 60_000);
  if (limited) return { ok: false, response: limited };

  // reportWhere() also honors a scoped API key's report allowlist (Phase
  // 3.2) — a key scoped to other reports gets the same 404 as a report
  // that doesn't exist, applied identically for both callers of this helper.
  const row = await prisma.report.findFirst({
    where: { id: reportId, ...reportWhere(user) },
  });
  if (!row) {
    return { ok: false, response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }

  let full: Report;
  try {
    full = ReportSchema.parse(JSON.parse(row.definition));
  } catch (e: any) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid report definition", detail: e?.message }, { status: 422 }),
    };
  }

  const paramsApplied = parseParams(url, full.parameters);
  const viewer: RunViewer = { id: user.id, isAdmin: user.role === "admin", roles: await getUserRoles() };
  // Only the queries behind blocks this caller may see. The dataset used to
  // carry every query, so an API key got the rows of a table the author hid
  // from its role.
  const report = visibleReport(full, viewer);
  const withheld = full.dataSources.length - report.dataSources.length;

  const started = Date.now();
  try {
    const { dataset, provenance } = await runReportWithProof({
      report,
      params: paramsApplied,
      tenantId: row.tenantId,
      viewer,
      cacheBust: opts.cacheBust,
    });

    // Time-travel: snapshot the dataset + provenance for replay on /history.
    // Cap snapshot size at 2 MB so we don't balloon the DB on huge exports.
    // Engine data is answered per person and must not be replayed to someone else: snapshotOf() leaves it out.
    const snapshot = snapshotOf(dataset, provenance);
    const outcome = runOutcome(provenance, withheld);
    await (prisma as any).reportRun.create({
      data: {
        tenantId: row.tenantId,
        reportId: row.id,
        userId: user.viaApiKey ? null : user.id,
        format: "html",
        params: JSON.stringify(paramsApplied),
        status: outcome.status,
        error: outcome.error ?? null,
        durationMs: Date.now() - started,
        dataset: snapshot.dataset,
        provenance: snapshot.provenance,
      },
    }).catch(() => null);

    return { ok: true, reportId: row.id, paramsApplied, dataset, provenance };
  } catch (e: any) {
    await (prisma as any).reportRun.create({
      data: {
        tenantId: row.tenantId,
        reportId: row.id,
        userId: user.viaApiKey ? null : user.id,
        format: "html",
        params: JSON.stringify(paramsApplied),
        status: "failed",
        error: e?.message ?? String(e),
        durationMs: Date.now() - started,
      },
    }).catch(() => null);
    return {
      ok: false,
      response: NextResponse.json({ error: e?.message ?? "Failed" }, { status: 500 }),
    };
  }
}
