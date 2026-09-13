/**
 * /api/reports/[id]/mv-prefill — return values to pre-fill the
 * materialized-view create form when an admin clicks "Cache as MV" from
 * the slow-query banner.
 *
 * Picks the first SQL DataSourceDef from the report definition (we only
 * support SQL-flavoured queries as MV sources today). Returns the raw SQL,
 * the source DataSource id, and a suggested name derived from the report.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser, requireReportInScope } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;

  const row = await prisma.report.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
    select: { id: true, name: true, definition: true },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let def: any = null;
  try { def = JSON.parse(row.definition); } catch { /* fall through */ }
  if (!def?.dataSources || !Array.isArray(def.dataSources)) {
    return NextResponse.json({ error: "Report has no data sources." }, { status: 422 });
  }

  // Pick the first query that has a SQL string. REST queries can't be
  // materialized via the report runner today (they go to a remote API,
  // not to a SQL engine).
  const sqlQuery = def.dataSources.find((d: any) => typeof d.sql === "string" && d.sql.trim().length > 0);
  if (!sqlQuery) {
    return NextResponse.json({ error: "Report has no SQL data source — REST queries can't be materialized yet." }, { status: 422 });
  }

  // Suggest a snake_case name derived from the report.
  const suggestedName = row.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50) || "cached_query";

  return NextResponse.json({
    suggestedName,
    suggestedSql: sqlQuery.sql,
    dataSourceId: sqlQuery.dataSourceId ?? null,
    suggestedCron: "0 */4 * * *", // every 4 hours by default
    sourceReportId: row.id,
    sourceReportName: row.name,
  });
}
