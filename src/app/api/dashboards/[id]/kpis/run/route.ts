import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser, getUserRoles } from "@/lib/auth";
import { canSeeDataSource } from "@/lib/datasourceAcl";
import { runSingleQuery } from "@/lib/reporting/runner";
import { extractSqlParamNames } from "@/lib/reporting/params";

/**
 * GET /api/dashboards/:id/kpis/run?p.region=...&p.province=...
 *
 * Re-runs the dashboard's top-KPI-strip queries bound to the caller's
 * current drill scope. prefetchDashboardPayload() computes these once,
 * unscoped, at page load — without this endpoint the strip stays frozen at
 * whole-tenant totals even after DashboardViewer's drill-through re-scopes
 * every report slot on the page, which reads as the KPI numbers being
 * wrong rather than just stale.
 *
 * Bound params are derived per-KPI from whatever `:name` placeholders its
 * own SQL references — not a fixed dimension list. A dashboard's KPIs can
 * reference any drill dimension that topic's tables use (region/province
 * for one topic, school/affiliation for another); a hardcoded list here
 * would throw "Missing parameter" for any topic outside that list.
 */

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const dashboard = await prisma.dashboard.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
  });
  if (!dashboard) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Same visibility gate as the page itself — a private dashboard's KPI
  // totals shouldn't leak through this endpoint even if the id is guessed.
  const isAdmin = user.role === "admin";
  const roles = user.viaApiKey ? [] : await getUserRoles();
  if (!canSeeDataSource(dashboard as any, { id: user.id, isAdmin, roles })) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const url = new URL(req.url);

  let topKpisDef: any[] = [];
  try { topKpisDef = JSON.parse(dashboard.topKpisJson ?? "[]"); } catch { /* corrupt */ }

  const topKpis = await Promise.all(
    topKpisDef.map(async (kpi) => {
      try {
        const bound = Object.fromEntries(
          extractSqlParamNames(kpi.query.sql).map((name) => [name, url.searchParams.get(`p.${name}`) ?? ""])
        );
        const rows = await runSingleQuery(kpi.query, bound);
        let value = 0;
        if (rows.length > 0) {
          const firstRow = rows[0] as any;
          const firstKey = Object.keys(firstRow)[0];
          value = Number(firstRow[firstKey]) || 0;
        }
        return { label: kpi.label, value, format: kpi.format };
      } catch (e: any) {
        return { label: kpi.label, error: e.message };
      }
    })
  );

  return NextResponse.json({ topKpis });
}
