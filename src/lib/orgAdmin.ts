/**
 * Org-level Platform Admin gate (2026-08 role restructure).
 *
 * Deliberately NOT named `isPlatformAdmin()` — that name is already taken
 * by `src/lib/platformAdmin.ts`, which means something unrelated: "one of
 * Curf's own internal operators" (email-allowlist via
 * CURF_PLATFORM_ADMIN_EMAILS, gates /admin/roadmap-status). This file is
 * the customer-facing concept instead: a person who holds
 * `OrgMembership(role: "platform_admin")` for an Organization, and can
 * therefore see every Tenant under it (even ones they've never joined —
 * see loadMembershipsForUserId() in src/lib/auth.ts) and manage who else
 * holds that grant.
 *
 * Always pair with `featureGate(user, "org.platform_admin")` — holding the
 * OrgMembership row is necessary but not sufficient; the capability itself
 * is Growth+ only. Community tenants get a real (harmless) OrgMembership
 * row at signup, same as everyone else, but the feature gate keeps it inert.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import type { CurfSessionUser } from "@/lib/auth";

/** Is this user a Platform Admin of the given Organization? */
export async function isOrgPlatformAdmin(user: CurfSessionUser, organizationId: string): Promise<boolean> {
  if (user.viaApiKey) return false; // API keys authenticate as a tenant, not a person — never org-wide.
  const grant = await prisma.orgMembership.findUnique({
    where: { userId_organizationId: { userId: user.id, organizationId } },
    select: { role: true },
  });
  return grant?.role === "platform_admin";
}

/** Is this user a Platform Admin of the Organization that owns their currently-active tenant? */
export async function isOrgPlatformAdminForActiveTenant(user: CurfSessionUser): Promise<boolean> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: user.tenantId },
    select: { organizationId: true },
  });
  if (!tenant?.organizationId) return false;
  return isOrgPlatformAdmin(user, tenant.organizationId);
}

/**
 * requireUser() + Platform-Admin-of-active-tenant's-org + Growth+ feature
 * gate, in one call. Mirrors requireAdmin()'s shape.
 */
export async function requireOrgPlatformAdmin(
  user: CurfSessionUser,
): Promise<{ organizationId: string } | NextResponse> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: user.tenantId },
    select: { organizationId: true },
  });
  if (!tenant?.organizationId) {
    return NextResponse.json({ error: "This workspace has no organization." }, { status: 404 });
  }
  const ok = await isOrgPlatformAdmin(user, tenant.organizationId);
  if (!ok) return NextResponse.json({ error: "Platform Admin only" }, { status: 403 });
  const { featureGate } = await import("@/lib/featureGate");
  const gated = await featureGate(user, "org.platform_admin");
  if (gated) return gated;
  return { organizationId: tenant.organizationId };
}
