/**
 * Workspace template applier.
 *
 *   const summary = await applyWorkspaceTemplate(tenantId, userId, template);
 *
 * Walks each kind of resource in the template and provisions it. Idempotent
 * on a name-collision basis — tables that already exist by name are
 * skipped (we don't want to overwrite a customer's real data with a
 * sample dataset). Reports / MVs / watchers also skip when a row with the
 * same name already exists.
 *
 * The applier returns a per-kind count breakdown so the API layer can
 * render a clean "✓ created 4 tables, 1 report, 1 watcher" summary even
 * when some items were skipped.
 */
import { prisma } from "@/lib/db";
import { createOrReplaceTable } from "@/lib/lake/tables";
import { lakeFileSize } from "@/lib/lake/storage";
import { ReportSchema } from "@/lib/reporting/schema";
import { requireReportQuota, requireWatcherQuota } from "@/lib/billing";
import type { CurfSessionUser } from "@/lib/auth";
import type { WorkspaceTemplate } from "./b2b-saas";

export type ApplySummary = {
  tablesCreated: number;
  tablesSkipped: number;
  reportsCreated: number;
  reportsSkipped: number;
  watchersCreated: number;
  watchersSkipped: number;
  mvsCreated: number;
  mvsSkipped: number;
  errors: string[];
};

export async function applyWorkspaceTemplate(
  user: CurfSessionUser,
  template: WorkspaceTemplate,
): Promise<ApplySummary> {
  const tenantId = user.tenantId;
  const userId = user.id;
  const summary: ApplySummary = {
    tablesCreated: 0,
    tablesSkipped: 0,
    reportsCreated: 0,
    reportsSkipped: 0,
    watchersCreated: 0,
    watchersSkipped: 0,
    mvsCreated: 0,
    mvsSkipped: 0,
    errors: [],
  };

  // Resolve the lake DataSource id once — every report's queries
  // reference it. Provision one if missing (mirrors the lake API's
  // upsert behaviour).
  let lakeDataSourceId: string;
  try {
    const ds = await prisma.dataSource.upsert({
      where: { tenantId_name: { tenantId, name: "Curf Tables" } },
      update: {},
      create: {
        tenantId,
        name: "Curf Tables",
        kind: "lake",
        connection: "lake://" + tenantId,
      },
      select: { id: true },
    });
    lakeDataSourceId = ds.id;
  } catch (e: any) {
    summary.errors.push(`Failed to ensure lake DataSource: ${e?.message ?? String(e)}`);
    return summary;
  }

  // 1. Lake tables. Each table goes through createOrReplaceTable +
  // a LakeTable Prisma row (mirroring the lake API's create path).
  for (const t of template.tables) {
    try {
      const existing = await prisma.lakeTable.findFirst({
        where: { tenantId, name: t.name },
        select: { id: true },
      });
      if (existing) {
        summary.tablesSkipped += 1;
        continue;
      }
      const result = createOrReplaceTable({
        tenantId,
        tableName: t.name,
        rows: t.rows,
        sourceKind: "manual",
        sourceConfig: { provenance: "workspace-template", templateId: template.id },
      });
      const sizeBytes = lakeFileSize(tenantId);
      await prisma.lakeTable.create({
        data: {
          tenantId,
          name: t.name,
          sourceKind: "manual",
          sourceConfigJson: JSON.stringify({ templateId: template.id }),
          schemaJson: JSON.stringify(result.columns),
          rowCount: result.rowCount,
          sizeBytes,
          description: t.description ?? null,
          createdById: userId,
        },
      });
      summary.tablesCreated += 1;
    } catch (e: any) {
      summary.errors.push(`table ${t.name}: ${e?.message ?? String(e)}`);
    }
  }

  // 2. Reports. Each builder takes the lake DS id so SQL queries point
  // at the right source.
  const reportIdByName = new Map<string, string>();
  for (const r of template.reports) {
    try {
      const existing = await prisma.report.findFirst({
        where: { tenantId, name: r.name },
        select: { id: true },
      });
      if (existing) {
        summary.reportsSkipped += 1;
        reportIdByName.set(r.name, existing.id);
        continue;
      }
      // Re-checked before every report, not just once up front — the count
      // moves as this loop creates rows, and a template can carry more
      // reports than a Community-tier tenant has quota left for.
      const quotaBlock = await requireReportQuota(user);
      if (quotaBlock) {
        summary.errors.push(`report ${r.name}: report quota reached for your plan — skipped.`);
        continue;
      }
      const def = r.buildDefinition(lakeDataSourceId);
      // Validate before write so a malformed builder doesn't ship a
      // bad row that crashes the viewer.
      const parsed = ReportSchema.parse(def);
      const created = await prisma.report.create({
        data: {
          tenantId,
          name: r.name,
          description: r.description,
          definition: JSON.stringify(parsed),
          published: true,
          createdById: userId,
        },
        select: { id: true, name: true },
      });
      reportIdByName.set(r.name, created.id);
      summary.reportsCreated += 1;
    } catch (e: any) {
      summary.errors.push(`report ${r.name}: ${e?.message ?? String(e)}`);
    }
  }

  // 3. Watchers. We persist as Schedule rows with kind="watcher" —
  // matches how the existing watchers UI creates them.
  for (const w of template.watchers) {
    try {
      const reportId = reportIdByName.get(w.reportName);
      if (!reportId) {
        summary.errors.push(`watcher ${w.name}: parent report "${w.reportName}" not found`);
        continue;
      }
      const existing = await prisma.schedule.findFirst({
        where: { tenantId, name: w.name, kind: "watcher" },
        select: { id: true },
      });
      if (existing) {
        summary.watchersSkipped += 1;
        continue;
      }
      // Same live re-check as reports — requireWatcherQuota also encodes
      // the Community-tier feature gate (watchersMax === 0 → "requires
      // Growth or higher"), so this single call replaces both checks.
      const quotaBlock = await requireWatcherQuota(user);
      if (quotaBlock) {
        summary.errors.push(`watcher ${w.name}: watcher quota/plan gate reached — skipped.`);
        continue;
      }
      await prisma.schedule.create({
        data: {
          tenantId,
          reportId,
          name: w.name,
          cron: w.cron,
          kind: "watcher",
          watcherConfigJson: JSON.stringify(w.config),
          createdById: userId,
        },
      });
      summary.watchersCreated += 1;
    } catch (e: any) {
      summary.errors.push(`watcher ${w.name}: ${e?.message ?? String(e)}`);
    }
  }

  // 4. Materialized views. Same shape as the MV admin page creates.
  for (const m of template.materializedViews) {
    try {
      const existing = await prisma.materializedView.findFirst({
        where: { tenantId, name: m.name },
        select: { id: true },
      });
      if (existing) {
        summary.mvsSkipped += 1;
        continue;
      }
      await prisma.materializedView.create({
        data: {
          tenantId,
          name: m.name,
          sql: m.sql,
          dataSourceId: lakeDataSourceId,
          cron: m.cron,
          enabled: true,
          description: m.description ?? null,
          createdById: userId,
        },
      });
      summary.mvsCreated += 1;
    } catch (e: any) {
      summary.errors.push(`mv ${m.name}: ${e?.message ?? String(e)}`);
    }
  }

  return summary;
}
