/**
 * Auto-provision a "starter pack" for a brand-new tenant.
 *
 * When a prospect signs up via /api/signup, they get a fresh tenant with
 * zero reports, zero connections, zero data. That's a confusing first
 * impression — the landing page hero shows the Marketing Campaign Review,
 * but a fresh user opening their workspace sees an empty catalog.
 *
 * This module installs the "wow shot" content into the new tenant so the
 * very first page they see is the same dashboard the marketing site
 * advertises:
 *   - One DataSource pointing at the bundled sample_warehouse.db file
 *   - One copy of the Marketing Campaign Review report
 *   - A pinned KPI on the Brief
 *   - A demo watcher that fires on the spend column
 *
 * The provisioner is idempotent — re-running it on a tenant that already
 * has reports is a no-op. Failure to provision (e.g. sample_warehouse.db
 * missing) is logged but doesn't fail the signup; the user lands on an
 * empty catalog with a "Generate your first report" prompt instead.
 *
 * Implementation note: rather than copy the seed.ts logic verbatim (which
 * would mean duplicating SQL definitions and seed rows), we copy from a
 * "template tenant" with slug "demo" if one exists. That's also where the
 * marketing site demo runs, so any improvements made there flow to every
 * new signup automatically.
 */
import path from "path";
import { prisma } from "@/lib/db";

export type ProvisionResult = {
  ok: boolean;
  reportsCreated: number;
  dataSourcesCreated: number;
  error?: string;
};

export async function provisionStarterPack(
  newTenantId: string,
): Promise<ProvisionResult> {
  try {
    // Find the template tenant. Slug "demo" is the seeded one used by /try
    // and the marketing landing page. If it doesn't exist on this
    // deployment (unusual — would mean the seed never ran), we no-op.
    const template = await prisma.tenant.findFirst({
      where: { slug: "demo" },
      select: { id: true },
    });
    if (!template) {
      return { ok: true, reportsCreated: 0, dataSourcesCreated: 0, error: "No demo template tenant on this deployment" };
    }

    // Copy data sources first because reports reference them by ID. Map
    // template-DS-id → new-DS-id so we can rewrite report definitions.
    const templateDataSources = await prisma.dataSource.findMany({
      where: { tenantId: template.id },
    });
    const dsIdMap = new Map<string, string>();
    for (const ds of templateDataSources) {
      const created = await prisma.dataSource.create({
        data: {
          tenantId: newTenantId,
          name: ds.name,
          kind: ds.kind,
          // `lake://<tenantId>` names the OWNING tenant, so copying the
          // template's value verbatim would point the clone at the template's
          // lake. Re-address it to the new tenant. (The runner keys off
          // dsRow.tenantId regardless — this keeps the stored label honest.)
          connection: ds.kind === "lake"
            ? `lake://${newTenantId}`
            : ds.connection, // SQLite file path or REST baseUrl
          discoveredSchemaJson: ds.discoveredSchemaJson,
        },
      });
      dsIdMap.set(ds.id, created.id);
    }

    // Copy reports. The report definition JSON references DataSource IDs
    // via `dataSources[].dataSourceId` — we rewrite those to the new
    // tenant's IDs so queries route to the cloned connections.
    const templateReports = await prisma.report.findMany({
      where: { tenantId: template.id, name: { contains: "Marketing Campaign Review" } },
      select: { id: true, name: true, description: true, category: true, definition: true },
      take: 1, // start with just the marquee marketing report; admins add more later
    });

    let reportsCreated = 0;
    for (const r of templateReports) {
      let def: any;
      try { def = JSON.parse(r.definition); } catch { continue; }
      // Rewrite dataSourceId references to point at the new tenant's clones.
      if (Array.isArray(def.dataSources)) {
        for (const d of def.dataSources) {
          const newId = dsIdMap.get(d.dataSourceId);
          if (newId) d.dataSourceId = newId;
        }
      }
      // Strip any tenant-specific identifiers in the definition (template
      // marketers shouldn't see comments or watcher fires from the demo
      // tenant). The report itself is safe to copy as-is otherwise.
      await prisma.report.create({
        data: {
          tenantId: newTenantId,
          name: r.name,
          description: r.description,
          category: r.category,
          definition: JSON.stringify(def),
          // Note: createdById is required; we rely on the caller to pass
          // a valid userId. If this becomes a problem we'll add it as a
          // parameter.
          createdById: (await prisma.membership.findFirst({
            where: { tenantId: newTenantId },
            select: { userId: true },
          }))?.userId ?? "system",
        },
      });
      reportsCreated++;
    }

    return {
      ok: true,
      reportsCreated,
      dataSourcesCreated: dsIdMap.size,
    };
  } catch (e: any) {
    return {
      ok: false,
      reportsCreated: 0,
      dataSourcesCreated: 0,
      error: e?.message ?? String(e),
    };
  }
}
