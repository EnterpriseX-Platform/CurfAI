/**
 * Looking up ANOTHER workspace — a marketplace author, the grantee of a
 * table share, a workspace the caller is deleting from a different one.
 *
 * Under row-level security a request bound to workspace A cannot see
 * workspace B's Tenant row (prisma/rls/policies.sql, curf_tenant_visible),
 * so these lookups answered "not found" once BE-TEN-03 landed. They run in
 * the system scope instead. The caller still makes every authorization
 * decision (may this user follow, share with, delete it?) and gets back
 * only the fields it selects.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { withSystemDbContext } from "@/lib/dbContext";

export function findWorkspaceBySlug<S extends Prisma.TenantSelect>(slug: string, select: S) {
  return withSystemDbContext(() => prisma.tenant.findUnique({ where: { slug }, select }));
}

export function findWorkspaceById<S extends Prisma.TenantSelect>(id: string, select: S) {
  return withSystemDbContext(() => prisma.tenant.findUnique({ where: { id }, select }));
}

/**
 * Whether an account also belongs to a workspace other than `tenantId`.
 * An account is one global row shared by every workspace it is in, and any
 * admin can add an existing account's email to their own workspace — so a
 * workspace may change the account's password or email only when it is the
 * account's ONLY workspace. Otherwise "add their email, then reset the
 * password" takes the account over everywhere.
 */
export async function belongsToOtherWorkspaces(userId: string, tenantId: string): Promise<boolean> {
  const n = await withSystemDbContext(() => prisma.membership.count({ where: { userId, tenantId: { not: tenantId } } }));
  return n > 0;
}
