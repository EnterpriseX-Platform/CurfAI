/**
 * GET /api/v1/reports/[id] — fetch one report's metadata + definition.
 *
 * Returns the validated ReportSchema JSON so external dashboards can
 * understand the block layout + queries without scraping the viewer HTML.
 *
 * Bearer-key callers see exactly the same shape session callers do.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Scoped API key (Phase 3.2) whose allowlist doesn't include this report.
  // Checked before the query — merging into `where` would need its own
  // `id` key, colliding with the specific-id filter below.
  if (user.scopedReportIds && !user.scopedReportIds.includes(params.id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const row = await prisma.report.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
    select: {
      id: true, name: true, description: true, category: true,
      version: true, definition: true, published: true, createdAt: true, updatedAt: true,
    },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let definition: any = null;
  try { definition = JSON.parse(row.definition); } catch { /* leave null */ }

  return NextResponse.json({
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    version: row.version,
    definition,
    // Lets external callers distinguish drafts from published reports —
    // the internal /api/reports/[id] route already surfaces this.
    published: row.published,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}
