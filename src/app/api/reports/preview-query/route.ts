import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runSingleQuery } from "@/lib/reporting/runner";
import { DataSourceDefSchema } from "@/lib/reporting/schema";
import { exportViewer } from "@/lib/reporting/exportCaller";
import { requireAdminOrEditor, blockScopedApiKey } from "@/lib/auth";

/**
 * POST /api/reports/preview-query
 *   body: { query: DataSourceDef, params?: Record<string, unknown> }
 *   resp: { rows, columns, durationMs }  on success
 *         { error } with status 400 on failure
 *
 * The designer's "Run query" and the metric editor's "Test" — builders
 * only, since it runs whatever SQL the body carries. It runs as the caller:
 * a source their role can't see is refused with the runner's "Hidden by
 * visibility" note, and sensitive lake columns come back redacted.
 */
const BodySchema = z.object({
  query: DataSourceDefSchema,
  params: z.record(z.unknown()).optional(),
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;
  // No existing report id to check against — this runs an arbitrary,
  // client-supplied query against any tenant data source, so a report-scoped
  // key must be blocked outright rather than getting a way around its limit.
  const scopeBlock = blockScopedApiKey(user);
  if (scopeBlock) return scopeBlock;

  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }

  const started = Date.now();
  try {
    const rows = await runSingleQuery(parsed.data.query, parsed.data.params ?? {}, await exportViewer(user), user.tenantId);
    const sample = rows.slice(0, 50);
    const columns = sample.length > 0 ? Object.keys(sample[0]) : [];
    return NextResponse.json({
      rows: sample,
      totalRows: rows.length,
      truncated: rows.length > sample.length,
      columns,
      durationMs: Date.now() - started,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Query failed" }, { status: 400 });
  }
}
