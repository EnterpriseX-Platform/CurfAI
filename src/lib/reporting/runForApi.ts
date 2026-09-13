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
import { ReportSchema } from "@/lib/reporting/schema";
import { runReportWithProof, type RunResult } from "@/lib/reporting/runner";
import { parseParams } from "@/lib/reporting/params";
import { getUserRoles, reportWhere, type CurfSessionUser } from "@/lib/auth";
import { ensureLimit } from "@/lib/rateLimit";

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

  let report: ReturnType<typeof ReportSchema.parse>;
  try {
    report = ReportSchema.parse(JSON.parse(row.definition));
  } catch (e: any) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid report definition", detail: e?.message }, { status: 422 }),
    };
  }

  const paramsApplied = parseParams(url, report.parameters);
  const userRoles = await getUserRoles();

  const started = Date.now();
  try {
    const { dataset, provenance } = await runReportWithProof({
      report,
      params: paramsApplied,
      viewer: { id: user.id, isAdmin: user.role === "admin", roles: userRoles },
      cacheBust: opts.cacheBust,
    });

    // Time-travel: snapshot the dataset + provenance for replay on /history.
    // Cap snapshot size at 2 MB so we don't balloon the DB on huge exports.
    const datasetJson = JSON.stringify(dataset);
    const snapshot = datasetJson.length < 2_000_000 ? datasetJson : null;
    await (prisma as any).reportRun.create({
      data: {
        tenantId: row.tenantId,
        reportId: row.id,
        userId: user.viaApiKey ? null : user.id,
        format: "html",
        params: JSON.stringify(paramsApplied),
        status: "completed",
        durationMs: Date.now() - started,
        dataset: snapshot,
        provenance: snapshot ? JSON.stringify(provenance) : null,
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
