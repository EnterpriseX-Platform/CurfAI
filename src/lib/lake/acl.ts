/**
 * Lake table access control.
 *
 * Same three-mode model as the existing DataSource ACL (see lib/datasourceAcl.ts):
 *
 *   ownerUserId set       → only that user can see ("Just me")
 *   visibleToRolesJson    → only users with ≥1 matching role
 *   both empty            → every tenant member with read access
 *
 * ownerUserId takes precedence when set. Admins do NOT auto-bypass —
 * a table marked "just me" is invisible to admins too. That matches
 * what the DataSource ACL does and keeps the mental model simple
 * ("I can mark something private and it's actually private").
 */
import { prisma } from "@/lib/db";

export type LakeAclMode =
  | { mode: "tenant" }
  | { mode: "roles"; roles: string[] }
  | { mode: "owner_only"; ownerUserId: string; isOwner: boolean };

export function decodeMode(row: { ownerUserId: string | null; visibleToRolesJson: string }): LakeAclMode {
  if (row.ownerUserId) {
    return { mode: "owner_only", ownerUserId: row.ownerUserId, isOwner: false };
  }
  let roles: string[] = [];
  try { const v = JSON.parse(row.visibleToRolesJson); if (Array.isArray(v)) roles = v.filter((r) => typeof r === "string"); }
  catch { /* default to tenant */ }
  if (roles.length === 0) return { mode: "tenant" };
  return { mode: "roles", roles };
}

export type LakeViewer = {
  id: string;
  tenantId: string;
  role: string;
  /** User's role slugs from the optional Role assignments. */
  roleSlugs: string[];
};

/**
 * Decide whether `viewer` can read this lake table. Pure function over
 * the decoded ACL — no DB calls. Caller should already have loaded the
 * LakeTable row.
 */
export function canRead(viewer: LakeViewer, row: { ownerUserId: string | null; visibleToRolesJson: string; tenantId: string }): boolean {
  if (viewer.tenantId !== row.tenantId) return false;
  const acl = decodeMode(row);
  if (acl.mode === "tenant") return true;
  if (acl.mode === "owner_only") return acl.ownerUserId === viewer.id;
  // mode === "roles"
  if (viewer.role === "admin") {
    // Admins still need to be in at least one of the listed roles. The
    // policy is "this is restricted to product folks" not "but admins
    // see everything anyway". If a tenant wants admin-implicit-access
    // they leave the table tenant-wide.
    // Note: this matches DataSource ACL behavior.
  }
  for (const r of acl.roles) {
    if (viewer.roleSlugs.includes(r)) return true;
  }
  return false;
}

/**
 * Resolve a viewer's role slugs from the Role assignments table. Cached
 * per request would be a future optimisation; for now this is one query
 * per call which is fine.
 */
export async function loadRoleSlugs(userId: string, tenantId: string): Promise<string[]> {
  try {
    const m = await prisma.membership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
      select: { rolesJson: true },
    });
    if (!m) return [];
    const parsed = JSON.parse(m.rolesJson ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((s: any) => typeof s === "string") : [];
  } catch { return []; }
}
