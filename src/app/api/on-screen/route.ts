/**
 * OnScreenDisplay collection endpoints.
 *
 * A separate, always-passive sibling of /api/dashboards — same shape and
 * security model (tenant scoping, visibility ACL, admin-only mutation), but
 * there is no `interactive` field: every OnScreenDisplay renders
 * non-interactive by construction (see DashboardViewer, reused by the
 * on-screen viewer with a forced `interactive: false`).
 *
 * GET  /api/on-screen — list displays the current user can see. Filters via
 *                        the same canSeeDataSource ACL helper Dashboard uses
 *                        (identical row shape: ownerUserId + visibleToRolesJson).
 * POST /api/on-screen — create. Admin-only. Validates report IDs belong to
 *                        the same tenant. Auto-generates a unique slug.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin, tenantWhere, getUserRoles, blockScopedApiKey } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { writeVisibility, canSeeDataSource, type Visibility } from "@/lib/datasourceAcl";
import { slugify, pickUniqueOnScreenSlug } from "@/lib/onScreen";

const VisibilityInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("tenant") }),
  z.object({ mode: z.literal("roles"), roles: z.array(z.string().min(1)).min(1) }),
  z.object({ mode: z.literal("owner_only") }),
]).optional();

const OnScreenInputSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/i).optional(),
  reportIds: z.array(z.string().min(1)).min(1).max(12),
  rotationSeconds: z.number().int().min(5).max(3600).default(30),
  theme: z.enum(["light", "dark"]).default("light"),
  layout: z.enum(["carousel", "table_only", "table_chart", "chart_only"]).default("table_only"),
  visibility: VisibilityInputSchema,
});

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scopeBlock = blockScopedApiKey(user);
  if (scopeBlock) return scopeBlock;

  const rowsAll = await prisma.onScreenDisplay.findMany({
    where: tenantWhere(user),
    orderBy: { createdAt: "desc" },
    include: {
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
  const parsed = OnScreenInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });
  }

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
  const slug = await pickUniqueOnScreenSlug(user.tenantId, baseSlug);

  const vIn = parsed.data.visibility;
  const visibility: Visibility = !vIn || vIn.mode === "tenant"
    ? { mode: "tenant" }
    : vIn.mode === "owner_only"
      ? { mode: "owner_only", ownerUserId: user.id }
      : { mode: "roles", roles: vIn.roles };
  const acl = writeVisibility(visibility);

  try {
    const created = await prisma.onScreenDisplay.create({
      data: {
        tenantId: user.tenantId,
        name: parsed.data.name,
        slug,
        reportIdsJson: JSON.stringify(orderedIds),
        rotationSeconds: parsed.data.rotationSeconds,
        theme: parsed.data.theme,
        layout: parsed.data.layout,
        visibleToRolesJson: acl.visibleToRolesJson,
        ownerUserId: acl.ownerUserId,
        createdById: user.id,
      },
    });
    recordAudit({
      user, kind: "onScreen.create", target: created.id, req,
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
    return NextResponse.json({ error: e?.message ?? "Failed to create on-screen display" }, { status: 500 });
  }
}
