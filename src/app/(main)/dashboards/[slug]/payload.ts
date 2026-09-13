/**
 * Dashboard payload prefetcher — shared between the authenticated viewer
 * (page.tsx) and the kiosk-token viewer (kiosk/page.tsx).
 *
 * Lives in a sibling module rather than page.tsx because Next.js App Router
 * page files may only export the framework's expected names (`default`,
 * `metadata`, `generateMetadata`, etc.). Re-exporting a helper from page.tsx
 * causes `tsc --noEmit` to fail on the generated `.next/types/.../page.ts`
 * d.ts shim.
 */
import { prisma } from "@/lib/db";
import { ReportSchema } from "@/lib/reporting/schema";
import { runReportWithProof, runSingleQuery } from "@/lib/reporting/runner";
import { extractSqlParamNames } from "@/lib/reporting/params";

/**
 * Resolve the dashboard's report list into ready-to-render payload. Reports
 * that no longer exist or that the viewer can no longer see are dropped
 * silently with a placeholder slot, so a missing report doesn't blank the
 * whole rotation.
 */
export async function prefetchDashboardPayload(dashboard: any) {
  let reportIds: string[] = [];
  try { reportIds = JSON.parse(dashboard.reportIdsJson ?? "[]"); }
  catch { /* corrupt → empty rotation */ }

  // Top-KPI strip formats currency client-side (no per-KPI report context
  // to read Report.currency from), so it resolves straight to the tenant
  // default — same fallback chain as ReportDocument, just missing the
  // report-level override step since these are cross-report aggregates.
  const tenantRow = await prisma.tenant.findUnique({
    where: { id: dashboard.tenantId },
    select: { currency: true },
  }).catch(() => null);
  const currency: string = tenantRow?.currency || "USD";

  // Fetch all reports in one query, scope by tenant, then re-order to match
  // the dashboard's preferred sequence (Prisma's findMany doesn't preserve order).
  const reportRows = await prisma.report.findMany({
    where: { id: { in: reportIds }, tenantId: dashboard.tenantId },
  });
  const byId = new Map(reportRows.map((r) => [r.id, r]));

  type Slot = {
    id: string;
    name: string;
    /** When defined, this report renders. When null, the slot shows a
     *  "report unavailable" placeholder (deleted, errored, etc). */
    rendered: null | {
      definition: any;
      dataset: Record<string, unknown[]>;
      provenance: Record<string, unknown>;
      params: Record<string, unknown>;
    };
    error?: string;
  };
  const slots: Slot[] = [];
  for (const id of reportIds) {
    const row = byId.get(id);
    if (!row) {
      slots.push({ id, name: "(deleted)", rendered: null, error: "Report no longer exists." });
      continue;
    }
    try {
      const def = ReportSchema.parse(JSON.parse(row.definition));
      // Default every parameter — the dashboard viewer doesn't expose a
      // parameter bar, so we render with whatever the report's defaults are.
      const pvals: Record<string, unknown> = {};
      for (const p of def.parameters) pvals[p.name] = p.default ?? "";
      const { dataset, provenance } = await runReportWithProof({ report: def, params: pvals });
      slots.push({
        id, name: row.name,
        rendered: { definition: def, dataset, provenance: provenance as any, params: pvals },
      });
    } catch (e: any) {
      slots.push({ id, name: row.name, rendered: null, error: e?.message ?? "Failed to render report." });
    }
  }

  let topKpisDef: any[] = [];
  try { topKpisDef = JSON.parse(dashboard.topKpisJson ?? "[]"); }
  catch { /* corrupt */ }

  let slotLayout: Record<string, { x: number; y: number; w: number; h: number }> = {};
  try { slotLayout = JSON.parse(dashboard.slotLayoutJson ?? "{}"); }
  catch { /* corrupt → auto-flow default positions */ }

  const topKpis = await Promise.all(
    topKpisDef.map(async (kpi) => {
      try {
        // Bind whatever :name placeholders this KPI's own SQL references to
        // "" (no-op filter, same convention report parameters use) — not a
        // fixed dimension list, since different dashboards' KPIs reference
        // different drill dimensions (region/province/... on one topic,
        // school/affiliation/... on another). GET /api/dashboards/:id/kpis/run
        // re-runs these same queries with real values once the viewer drills in.
        const baseDrillParams = Object.fromEntries(extractSqlParamNames(kpi.query.sql).map((n) => [n, ""]));
        const rows = await runSingleQuery(kpi.query, baseDrillParams);
        // Get the first value of the first row
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

  return {
    id: dashboard.id,
    slug: dashboard.slug,
    name: dashboard.name,
    rotationSeconds: dashboard.rotationSeconds,
    theme: dashboard.theme as "light" | "dark",
    layout: (dashboard.layout ?? "carousel") as "carousel" | "grid_2x2" | "grid_2x1" | "custom",
    currency,
    topKpis,
    slotLayout,
    slots,
  };
}
