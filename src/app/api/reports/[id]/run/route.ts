import { NextRequest, NextResponse } from "next/server";
import { requireUser, requireReportInScope } from "@/lib/auth";
import { runReportForApi } from "@/lib/reporting/runForApi";

/**
 * GET /api/reports/:id/run?p.from=...&p.to=...
 * Returns { dataset, provenance, params } for the viewer.
 *
 * Core run/rate-limit/history logic lives in runForApi() — shared with
 * GET /api/v1/reports/[id]/data so the two entry points can't drift again.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;

  const result = await runReportForApi(user, params.id, new URL(req.url));
  if (!result.ok) return result.response;

  return NextResponse.json({
    dataset: result.dataset,
    provenance: result.provenance,
    params: result.paramsApplied,
  });
}
