/**
 * Dashboard collection endpoints.
 *
 * GET  /api/dashboards     — list dashboards the current user can see.
 *                            Filters via the same canSeeDataSource ACL helper
 *                            (the row shape is identical: ownerUserId +
 *                            visibleToRolesJson).
 * POST /api/dashboards     — create. Admin-only. Validates report IDs belong
 *                            to the same tenant. Auto-generates a unique
 *                            slug from the name when one isn't provided.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin, tenantWhere, getUserRoles, blockScopedApiKey } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { writeVisibility, canSeeDataSource, type Visibility } from "@/lib/datasourceAcl";
import { requireDashboardQuota, withSerializableRetry, QuotaBlockedError } from "@/lib/billing";
import { TopKpiDefSchema } from "@/lib/reporting/schema";
import { slugify, pickUniqueSlug, computeDashboardHealth } from "@/lib/dashboards";

const VisibilityInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("tenant") }),
  z.object({ mode: z.literal("roles"), roles: z.array(z.string().min(1)).min(1) }),
  z.object({ mode: z.literal("owner_only") }),
]).optional();

const DashboardInputSchema = z.object({
  name: z.string().min(1).max(120),
  // Slug is auto-derived from name when missing. Validated below if provided.
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/i).optional(),
  reportIds: z.array(z.string().min(1)).min(1).max(12),
  rotationSeconds: z.number().int().min(5).max(3600).default(30),
  theme: z.enum(["light", "dark"]).default("light"),
  layout: z.enum(["carousel", "grid_2x1", "grid_2x2", "grid_3x3", "table_only", "table_chart", "chart_only", "custom"]).default("table_only"),
  visibility: VisibilityInputSchema,
  topKpis: z.array(TopKpiDefSchema).default([]),
});

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scopeBlock = blockScopedApiKey(user);
  if (scopeBlock) return scopeBlock;

  const rowsAll = await prisma.dashboard.findMany({
    where: tenantWhere(user),
    orderBy: { createdAt: "desc" },
    include: {
      // Active (non-revoked, non-expired) kiosk-token count for the chip.
      _count: { select: { kioskTokens: true } },
    },
  });

  const userRoles = await getUserRoles();
  const isAdmin = user.role === "admin";
  const rows = rowsAll.filter((r: any) =>
    canSeeDataSource(r, { id: user.id, isAdmin, roles: userRoles }),
  );

  return NextResponse.json({
    items: rows.map((r: any) => {
      let reportIds: string[] = [];
      try { reportIds = JSON.parse(r.reportIdsJson ?? "[]"); }
      catch { /* corrupt — surface empty */ }
      return {
        id: r.id,
        name: r.name,
        slug: r.slug,
        reportIds,
        reportCount: reportIds.length,
        rotationSeconds: r.rotationSeconds,
        theme: r.theme,
        layout: r.layout ?? "carousel",
        visibility: r.ownerUserId
          ? { mode: "owner_only" as const, ownerUserId: r.ownerUserId, isOwner: r.ownerUserId === user.id }
          : (() => {
              let roles: string[] = [];
              try {
                const parsed = JSON.parse(r.visibleToRolesJson ?? "[]");
                if (Array.isArray(parsed)) roles = parsed.filter((s: any) => typeof s === "string");
              } catch { /* corrupt → tenant */ }
              return roles.length > 0 ? { mode: "roles" as const, roles } : { mode: "tenant" as const };
            })(),
        kioskTokenCount: r._count?.kioskTokens ?? 0,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        isMine: r.createdById === user.id,
        // Hub-grid heuristic — see computeDashboardHealth() for what feeds it.
        healthScore: computeDashboardHealth(r.updatedAt, reportIds.length),
      };
    }),
  });
}

export async function POST(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;
  const scopeBlock = blockScopedApiKey(user);
  if (scopeBlock) return scopeBlock;

  const body = await req.json().catch(() => null);
  const parsed = DashboardInputSchema.safeParse(body);
  if (!parsed.success) {
    console.error("Dashboard POST Validation Error:", JSON.stringify(parsed.error.issues, null, 2));
    return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });
  }

  // Verify every report id is in the same tenant. Don't 404 on the first
  // missing one — return all so the UI can highlight which were dropped.
  const reportRows = await prisma.report.findMany({
    where: { id: { in: parsed.data.reportIds }, tenantId: user.tenantId },
    select: { id: true },
  });
  const validIds = new Set(reportRows.map((r) => r.id));
  const orderedIds = parsed.data.reportIds.filter((id) => validIds.has(id));
  if (orderedIds.length === 0) {
    return NextResponse.json({ error: "None of the supplied report IDs belong to this tenant." }, { status: 400 });
  }

  const baseSlug = parsed.data.slug ?? slugify(parsed.data.name);
  const slug = await pickUniqueSlug(user.tenantId, baseSlug);

  const vIn = parsed.data.visibility;
  const visibility: Visibility = !vIn || vIn.mode === "tenant"
    ? { mode: "tenant" }
    : vIn.mode === "owner_only"
      ? { mode: "owner_only", ownerUserId: user.id }
      : { mode: "roles", roles: vIn.roles };
  const acl = writeVisibility(visibility);

  try {
    // Quota check + create share one SERIALIZABLE transaction (OWASP
    // A06:2025) — concurrent requests racing the same tenant's cap can no
    // longer all pass the check before any of them lands.
    const created = await withSerializableRetry(async (tx) => {
      const quotaBlock = await requireDashboardQuota(user, tx);
      if (quotaBlock) throw new QuotaBlockedError(quotaBlock);
      return tx.dashboard.create({
        data: {
          tenantId: user.tenantId,
          name: parsed.data.name,
          slug,
          reportIdsJson: JSON.stringify(orderedIds),
          rotationSeconds: parsed.data.rotationSeconds,
          theme: parsed.data.theme,
          layout: parsed.data.layout,
          topKpisJson: JSON.stringify(parsed.data.topKpis),
          visibleToRolesJson: acl.visibleToRolesJson,
          ownerUserId: acl.ownerUserId,
          createdById: user.id,
        },
      });
    });
    recordAudit({
      user, kind: "dashboard.create", target: created.id, req,
      meta: {
        name: parsed.data.name,
        slug,
        reportCount: orderedIds.length,
        droppedIds: parsed.data.reportIds.length - orderedIds.length,
        visibility: visibility.mode,
      },
    });
    return NextResponse.json({ id: created.id, name: created.name, slug: created.slug });
  } catch (e: any) {
    if (e instanceof QuotaBlockedError) return e.response;
    return NextResponse.json({ error: e?.message ?? "Failed to create dashboard" }, { status: 500 });
  }
}
