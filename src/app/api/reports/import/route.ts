/**
 * POST /api/reports/import
 *
 * Generic "import this validated report definition" endpoint. Body:
 *   {
 *     definition: ReportSchema,         // full sanitized JSON
 *     wiring: { placeholder: id },      // optional; defaults to {}
 *     name: string,                     // optional override
 *   }
 *
 * Used by the /reports/import?from=<url> flow when the source is a
 * raw URL (not a marketplace template). Marketplace imports go through
 * /api/marketplace/templates/[slug]/import instead so the downloads
 * counter increments.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, requireAdminOrEditor, blockScopedApiKey } from "@/lib/auth";
import { withTenantContext } from "@/lib/rls";
import { recordAudit } from "@/lib/audit";
import { ReportSchema } from "@/lib/reporting/schema";
import { requireReportQuota } from "@/lib/billing";
import { cloneIntoTenant, isPlaceholder } from "@/lib/reporting/sanitizeTemplate";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ImportSchema = z.object({
  definition: z.any(),
  wiring: z.record(z.string()).optional().default({}),
  name: z.string().min(1).max(120).optional(),
  /** Optional source URL — recorded in the audit meta for traceability. */
  sourceUrl: z.string().url().max(500).optional().nullable(),
});

export async function POST(req: NextRequest) {
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;
  // A report-scoped key is meant to be limited to its allowlisted reports —
  // importing a brand-new one (wired to any tenant data source) is outside
  // that mandate.
  const scopeBlock = blockScopedApiKey(user);
  if (scopeBlock) return scopeBlock;
  const block = await requireReportQuota(user);
  if (block) return block;

  const body = await req.json().catch(() => ({}));
  const parsed = ImportSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });

  // Verify wiring entries point at this tenant's connections.
  const wireIds = Object.values(parsed.data.wiring);
  if (wireIds.length > 0) {
    const owned = await prisma.dataSource.findMany({
      where: { tenantId: user.tenantId, id: { in: wireIds } },
      select: { id: true },
    });
    const ownedSet = new Set(owned.map((d) => d.id));
    for (const id of wireIds) {
      if (!ownedSet.has(id)) {
        return NextResponse.json({ error: `DataSource ${id} not owned by your tenant.` }, { status: 400 });
      }
    }
  }

  // For non-placeholder dataSourceIds in the source definition, refuse
  // to import — they reference IDs from another tenant that mean
  // nothing here. The wiring map is the only sanctioned way to point
  // queries at real connections in your workspace.
  if (Array.isArray(parsed.data.definition?.dataSources)) {
    for (const ds of parsed.data.definition.dataSources) {
      if (ds.dataSourceId && !isPlaceholder(ds.dataSourceId)) {
        // Replace with a placeholder so cloneIntoTenant() handles it
        // uniformly. The runner sees an empty id → empty rows + hint.
        ds.dataSourceId = "__placeholder__:unknown_imported";
      }
    }
  }

  const cloned = cloneIntoTenant({
    template: parsed.data.definition,
    wiring: parsed.data.wiring,
  });
  if (parsed.data.name) cloned.name = parsed.data.name;

  const validated = ReportSchema.safeParse(cloned);
  if (!validated.success) {
    return NextResponse.json({
      error: "Imported definition failed validation",
      issues: validated.error.issues.slice(0, 8),
    }, { status: 422 });
  }

  const created = await withTenantContext(user, (tx) =>
    tx.report.create({
      data: {
        tenantId: user.tenantId,
        name: validated.data.name,
        description: validated.data.description ?? null,
        category: validated.data.category ?? null,
        definition: JSON.stringify(validated.data),
        createdById: user.id,
      },
    }),
  );

  recordAudit({
    user, kind: "report.import", target: created.id, req,
    meta: { sourceUrl: parsed.data.sourceUrl ?? null, wiringCount: wireIds.length },
  });

  return NextResponse.json({
    id: created.id,
    name: created.name,
    redirectTo: "/reports/" + created.id + "/edit",
  });
}
