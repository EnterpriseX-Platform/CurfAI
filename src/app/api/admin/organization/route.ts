/**
 * GET/PATCH /api/admin/organization — Platform Admin's org-wide view.
 *
 * Only reachable by a Platform Admin of the Organization that owns the
 * caller's currently-active tenant, AND only once that org unlocks
 * "org.platform_admin" (Growth+) — see requireOrgPlatformAdmin() in
 * src/lib/orgAdmin.ts. A regular per-tenant Admin gets 403/404 here and
 * keeps using the ordinary /api/admin/users flow for their own workspace.
 *
 * GET returns every tenant + member in the org, aggregated across
 * workspaces — deliberately NOT scoped to tenantWhere(user) the way every
 * other admin route is, since seeing across tenants is the entire point.
 *
 * PATCH takes one of three actions:
 *   - grant_platform_admin / revoke_platform_admin: the target must already
 *     be a member of SOME tenant in this org (an org invite is just the
 *     ordinary per-tenant invite in /api/admin/users — there's no separate
 *     "join the org with no workspace" flow, see CLAUDE.md's invite-only
 *     membership growth).
 *   - set_role: change a member's role in ANY tenant in the org, bypassing
 *     the normal "only that tenant's own admin can edit its users" limit.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, MEMBERSHIP_ROLES } from "@/lib/auth";
import { requireOrgPlatformAdmin } from "@/lib/orgAdmin";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const gate = await requireOrgPlatformAdmin(user);
  if (gate instanceof NextResponse) return gate;

  const [organization, tenants, platformAdmins] = await Promise.all([
    prisma.organization.findUnique({ where: { id: gate.organizationId } }),
    prisma.tenant.findMany({
      where: { organizationId: gate.organizationId },
      select: { id: true, name: true, slug: true },
      orderBy: { name: "asc" },
    }),
    prisma.orgMembership.findMany({
      where: { organizationId: gate.organizationId, role: "platform_admin" },
      select: { userId: true },
    }),
  ]);
  const platformAdminIds = new Set(platformAdmins.map((p) => p.userId));

  const memberships = await prisma.membership.findMany({
    where: { tenantId: { in: tenants.map((t) => t.id) } },
    include: { user: { select: { id: true, email: true, name: true } } },
  });
  const tenantById = new Map(tenants.map((t) => [t.id, t]));

  const byUser = new Map<string, {
    userId: string; email: string; name: string | null; isPlatformAdmin: boolean;
    tenantRoles: { tenantId: string; tenantName: string; role: string }[];
  }>();
  for (const m of memberships as any[]) {
    const entry = byUser.get(m.userId) ?? {
      userId: m.userId,
      email: m.user.email,
      name: m.user.name,
      isPlatformAdmin: platformAdminIds.has(m.userId),
      tenantRoles: [] as { tenantId: string; tenantName: string; role: string }[],
    };
    const tenant = tenantById.get(m.tenantId);
    if (tenant) entry.tenantRoles.push({ tenantId: tenant.id, tenantName: tenant.name, role: m.role });
    byUser.set(m.userId, entry);
  }

  return NextResponse.json({
    organization,
    tenants,
    members: Array.from(byUser.values()).sort((a, b) => a.email.localeCompare(b.email)),
  });
}

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("grant_platform_admin"), userId: z.string().min(1) }),
  z.object({ action: z.literal("revoke_platform_admin"), userId: z.string().min(1) }),
  z.object({ action: z.literal("set_role"), userId: z.string().min(1), tenantId: z.string().min(1), role: z.enum(MEMBERSHIP_ROLES) }),
]);

export async function PATCH(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const gate = await requireOrgPlatformAdmin(user);
  if (gate instanceof NextResponse) return gate;

  const parsed = ActionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });
  const { organizationId } = gate;

  if (parsed.data.action === "grant_platform_admin" || parsed.data.action === "revoke_platform_admin") {
    const { userId } = parsed.data;
    const isOrgMember = await prisma.membership.findFirst({
      where: { userId, tenant: { organizationId } },
      select: { id: true },
    });
    if (!isOrgMember) {
      return NextResponse.json(
        { error: "That account isn't a member of any workspace in this organization yet — invite them into a workspace first." },
        { status: 404 },
      );
    }

    if (parsed.data.action === "grant_platform_admin") {
      await prisma.orgMembership.upsert({
        where: { userId_organizationId: { userId, organizationId } },
        update: { role: "platform_admin" },
        create: { userId, organizationId, role: "platform_admin" },
      });
      recordAudit({ user, kind: "org.platform_admin.grant", target: userId, req, organizationId });
    } else {
      // Never let the last Platform Admin revoke themselves (or the only
      // other one) out of managing the org at all.
      const remaining = await prisma.orgMembership.count({
        where: { organizationId, role: "platform_admin", userId: { not: userId } },
      });
      if (remaining === 0) {
        return NextResponse.json({ error: "Can't revoke the last Platform Admin of this organization." }, { status: 400 });
      }
      await prisma.orgMembership.deleteMany({ where: { userId, organizationId } });
      recordAudit({ user, kind: "org.platform_admin.revoke", target: userId, req, organizationId });
    }
    return NextResponse.json({ ok: true });
  }

  // set_role — change a member's role in ANY tenant within this org.
  const { userId, tenantId, role } = parsed.data;
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { organizationId: true, name: true } });
  if (!tenant || tenant.organizationId !== organizationId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const membership = await prisma.membership.findUnique({ where: { userId_tenantId: { userId, tenantId } } });
  if (!membership) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.membership.update({ where: { userId_tenantId: { userId, tenantId } }, data: { role } });
  recordAudit({
    user, kind: "role.assign", target: userId, req,
    tenantId, // attribute to the tenant whose Membership actually changed
    organizationId,
    meta: { previousRole: membership.role, newRole: role, viaOrganizationTab: true },
  });
  return NextResponse.json({ ok: true });
}
