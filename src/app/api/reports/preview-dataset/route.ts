import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runReport } from "@/lib/reporting/runner";
import { ReportSchema } from "@/lib/reporting/schema";
import { exportViewer } from "@/lib/reporting/exportCaller";
import { requireAdminOrEditor, blockScopedApiKey } from "@/lib/auth";

/**
 * POST /api/reports/preview-dataset
 *
 * Takes an UNSAVED report definition (the one currently in the designer's
 * Zustand store) plus a parameter bag, executes all queries via the same
 * runner the viewer uses, and returns the dataset map.
 *
 * Used by the designer's "Run" button to refresh the canvas without having
 * to save + reload the edit page. The designer is for builders, and so is
 * this: it runs whatever SQL the body carries. It runs as the caller, so a
 * source their role can't see comes back empty, as it does in the viewer.
 */
const BodySchema = z.object({
  report: ReportSchema,
  params: z.record(z.unknown()).optional(),
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;
  // No existing report id to check against — this runs an arbitrary,
  // client-supplied report definition against any tenant data source, so a
  // report-scoped key (meant to be limited to its allowlisted reports) must
  // be blocked outright rather than getting a way around that limit.
  const scopeBlock = blockScopedApiKey(user);
  if (scopeBlock) return scopeBlock;

  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }

  const started = Date.now();
  try {
    const dataset = await runReport({
      report: parsed.data.report,
      params: parsed.data.params ?? {},
      tenantId: user.tenantId,
      viewer: await exportViewer(user),
    });
    // Include a small summary per query so the UI can show status chips.
    const summary: Record<string, { rows: number }> = {};
    for (const [queryId, rows] of Object.entries(dataset)) {
      summary[queryId] = { rows: rows.length };
    }
    return NextResponse.json({
      dataset,
      summary,
      durationMs: Date.now() - started,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Query failed" }, { status: 400 });
  }
}
