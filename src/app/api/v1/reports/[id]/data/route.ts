/**
 * GET /api/v1/reports/[id]/data — run a report and return the dataset JSON.
 *
 * The headline programmatic endpoint. Pipe a report's data into BI tools,
 * Notion, internal dashboards, or anything that can hit an HTTPS endpoint.
 *
 * Parameters: pass `?p.<name>=<value>` for each report parameter, mirroring
 * the viewer URL convention. Defaults from the report's parameter spec
 * apply when not supplied.
 *
 * Response: { dataset: { [queryId]: rows[] } } — same shape the viewer
 * uses internally. queryIds are stable across runs so consumers can pin
 * to a specific block's data.
 *
 * Core run/rate-limit/history logic lives in runForApi() — shared with
 * GET /api/reports/[id]/run so the two entry points can't drift again
 * (this one used to skip rate limiting and ReportRun history entirely).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { runReportForApi } from "@/lib/reporting/runForApi";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  // ?bust=1 — bypass the in-process query result cache and force fresh
  // execution. Used by the viewer's "refresh" button and by callers that
  // know they just mutated underlying data.
  const cacheBust = url.searchParams.get("bust") === "1";

  const result = await runReportForApi(user, params.id, url, { cacheBust });
  if (!result.ok) return result.response;

  return NextResponse.json({
    dataset: result.dataset,
    paramsApplied: result.paramsApplied,
  });
}
