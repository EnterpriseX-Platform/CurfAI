/**
 * Dashboard item endpoints.
 *
 * GET    — fetch one dashboard for the manage UI. Includes the current set
 *          of kiosk tokens (masked — only id/label/expiresAt/lastUsedAt) so
 *          the manage page can render the token list without a second call.
 * PATCH  — partial update. Admin only.
 * DELETE — remove. Admin only. Cascade kills any kiosk tokens via the
 *          schema's onDelete: Cascade.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin, getUserRoles, blockScopedApiKey } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { writeVisibility, canSeeDataSource, type Visibility } from "@/lib/datasourceAcl";

const VisibilityInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("tenant") }),
  z.object({ mode: z.literal("roles"), roles: z.array(z.string().min(1)).min(1) }),
  z.object({ mode: z.literal("owner_only") }),
]).optional();

const SlotLayoutEntrySchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1),
});

const PatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  reportIds: z.array(z.string().min(1)).min(1).max(12).optional(),
  rotationSeconds: z.number().int().min(5).max(3600).optional(),
  theme: z.enum(["light", "dark"]).optional(),
  layout: z.enum(["carousel", "grid_2x1", "grid_2x2", "grid_3x3", "table_only", "table_chart", "chart_only", "custom"]).optional(),
  visibility: VisibilityInputSchema,
  topKpis: z.array(z.any()).optional(), // We'll let z.any here and cast it to TopKpiDefSchema
  // reportId -> {x,y,w,h}. Only meaningful when layout === "custom" — see
  // DashboardViewer.tsx's free-form grid.
  slotLayout: z.record(SlotLayoutEntrySchema).optional(),
});

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scopeBlock = blockScopedApiKey(user);
  if (scopeBlock) return scopeBlock;

  const row = await prisma.dashboard.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
    include: {
      kioskTokens: {
        // Hide revoked tokens from the list — they're audit-trail only and
        // can't be reactivated. Sort newest first.
        where: { revokedAt: null },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          label: true,
          expiresAt: true,
          lastUsedAt: true,
          createdAt: true,
        },
      },
    },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Visibility check uses the same helper the listing uses, so private
  // dashboards stay private even if someone guesses the id.
  const userRoles = await getUserRoles();
  const isAdmin = user.role === "admin";
  if (!canSeeDataSource(row, { id: user.id, isAdmin, roles: userRoles })) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let reportIds: string[] = [];
  try { reportIds = JSON.parse(row.reportIdsJson ?? "[]"); }
  catch { /* corrupt → empty */ }

  return NextResponse.json({
    id: row.id,
    name: row.name,
    slug: row.slug,
    reportIds,
    rotationSeconds: row.rotationSeconds,
    theme: row.theme,
    layout: row.layout ?? "carousel",
    topKpis: (() => {
      try {
        return JSON.parse(row.topKpisJson ?? "[]");
      } catch { return []; }
    })(),
    slotLayout: (() => {
      try {
        return JSON.parse(row.slotLayoutJson ?? "{}");
      } catch { return {}; }
    })(),
    visibility: row.ownerUserId
      ? { mode: "owner_only" as const, ownerUserId: row.ownerUserId, isOwner: row.ownerUserId === user.id }
      : (() => {
          let roles: string[] = [];
          try {
            const parsed = JSON.parse(row.visibleToRolesJson ?? "[]");
            if (Array.isArray(parsed)) roles = parsed.filter((s: any) => typeof s === "string");
          } catch { /* corrupt → tenant */ }
          return roles.length > 0 ? { mode: "roles" as const, roles } : { mode: "tenant" as const };
        })(),
    kioskTokens: row.kioskTokens,
    createdAt: row.createdAt,
  });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;
  const scopeBlock = blockScopedApiKey(user);
  if (scopeBlock) return scopeBlock;

  const existing = await prisma.dashboard.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });

  const data: any = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.rotationSeconds !== undefined) data.rotationSeconds = parsed.data.rotationSeconds;
  if (parsed.data.theme !== undefined) data.theme = parsed.data.theme;
  if (parsed.data.layout !== undefined) data.layout = parsed.data.layout;
  if (parsed.data.topKpis !== undefined) data.topKpisJson = JSON.stringify(parsed.data.topKpis);
  // Tracks whichever report id set is in effect after this PATCH — either
  // the freshly-validated `orderedIds` below, or the dashboard's existing
  // set when this request only touches slotLayout (e.g. the "Save Layout"
  // button, which never sends reportIds).
  let currentReportIds: string[] | null = null;
  if (parsed.data.reportIds !== undefined) {
    // Re-validate tenant ownership on every update — protects against
    // PATCH-after-id-leak from another tenant.
    const reportRows = await prisma.report.findMany({
      where: { id: { in: parsed.data.reportIds }, tenantId: user.tenantId },
      select: { id: true },
    });
    const validIds = new Set(reportRows.map((r) => r.id));
    const orderedIds = parsed.data.reportIds.filter((id) => validIds.has(id));
    if (orderedIds.length === 0) {
      return NextResponse.json({ error: "None of the supplied report IDs belong to this tenant." }, { status: 400 });
    }
    data.reportIdsJson = JSON.stringify(orderedIds);
    currentReportIds = orderedIds;
  }
  if (parsed.data.slotLayout !== undefined) {
    if (currentReportIds === null) {
      try { currentReportIds = JSON.parse(existing.reportIdsJson ?? "[]"); }
      catch { currentReportIds = []; }
    }
    const allowed = new Set(currentReportIds);
    const filtered = Object.fromEntries(
      Object.entries(parsed.data.slotLayout).filter(([reportId]) => allowed.has(reportId))
    );
    data.slotLayoutJson = JSON.stringify(filtered);
  }
  if (parsed.data.visibility) {
    const v: Visibility =
      parsed.data.visibility.mode === "tenant"     ? { mode: "tenant" }
    : parsed.data.visibility.mode === "owner_only" ? { mode: "owner_only", ownerUserId: user.id }
    :                                                { mode: "roles", roles: parsed.data.visibility.roles };
    const acl = writeVisibility(v);
    data.visibleToRolesJson = acl.visibleToRolesJson;
    data.ownerUserId        = acl.ownerUserId;
  }

  const updated = await prisma.dashboard.update({ where: { id: params.id }, data });
  recordAudit({
    user, kind: "dashboard.update", target: params.id, req,
    meta: { name: updated.name, fields: Object.keys(data) },
  });
  return NextResponse.json({ id: updated.id, name: updated.name, slug: updated.slug });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;
  const scopeBlock = blockScopedApiKey(user);
  if (scopeBlock) return scopeBlock;
  const existing = await prisma.dashboard.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
    select: { id: true, name: true },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.dashboard.delete({ where: { id: params.id } });
  recordAudit({
    user, kind: "dashboard.delete", target: params.id, req,
    meta: { name: existing.name },
  });
  return NextResponse.json({ ok: true });
}
