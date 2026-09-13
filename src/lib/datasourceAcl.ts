/**
 * DataSource visibility (ACL).
 *
 * Two orthogonal restriction modes, evaluated in order:
 *
 *   1. ownerUserId set → "Just me". Only the named user can see / use the
 *      source. Admins do NOT bypass — that's the whole point of the mode.
 *      Useful for personal-import flows ("my CSV, not a team resource").
 *
 *   2. visibleToRolesJson is a non-empty role-slug array → "Roles". Only
 *      users whose rolesJson intersects with the list can see it. Admins
 *      DO bypass this mode (same as the block-level filter), since admins
 *      manage all sources operationally.
 *
 *   3. Both empty / unset → "Tenant". Every tenant member with read access
 *      to the connections page can use it. (Default behaviour, matches
 *      historical sources from before this column existed.)
 *
 * The viewer/runner uses these helpers to filter at every read site:
 *  - GET /api/data-sources (listing)
 *  - GET /api/reports/generate/inventory (AI Generate picker)
 *  - /api/reports/generate POST (target picker default)
 *  - /api/reports/[id] runner path (defense-in-depth — empty-result for
 *    queries that reference an unauthorised source)
 *
 * The model intentionally mirrors the block-level visibleToRoles pattern,
 * lifted up one level to the connection itself.
 */
export type Visibility =
  | { mode: "tenant" }
  | { mode: "roles"; roles: string[] }
  | { mode: "owner_only"; ownerUserId: string };

export type DataSourceAclRow = {
  visibleToRolesJson?: string | null;
  ownerUserId?: string | null;
};

/** Parse the persisted columns into a typed Visibility. */
export function readVisibility(row: DataSourceAclRow): Visibility {
  if (row.ownerUserId) return { mode: "owner_only", ownerUserId: row.ownerUserId };
  let roles: string[] = [];
  try {
    const parsed = JSON.parse(row.visibleToRolesJson ?? "[]");
    if (Array.isArray(parsed)) roles = parsed.filter((s) => typeof s === "string");
  } catch { /* corrupt JSON → treat as tenant */ }
  if (roles.length > 0) return { mode: "roles", roles };
  return { mode: "tenant" };
}

/** Write back into the two persisted columns. */
export function writeVisibility(v: Visibility): { visibleToRolesJson: string; ownerUserId: string | null } {
  if (v.mode === "owner_only") return { visibleToRolesJson: "[]", ownerUserId: v.ownerUserId };
  if (v.mode === "roles")     return { visibleToRolesJson: JSON.stringify(v.roles), ownerUserId: null };
  return { visibleToRolesJson: "[]", ownerUserId: null };
}

/**
 * The authoritative gate. Returns true iff the named user is allowed to use
 * this DataSource. Pass the row and the user's currently-resolved roles +
 * isAdmin flag (cheap to compute via getUserRoles + user.role === "admin").
 *
 * Note: tenant scoping is the caller's responsibility — this function does
 * NOT check that ds.tenantId === user.tenantId. Callers always combine with
 * a `where: tenantWhere(user)` clause first.
 */
export function canSeeDataSource(
  row: DataSourceAclRow,
  user: { id: string; isAdmin: boolean; roles: string[] },
): boolean {
  // Owner-only: only the literal user, no admin bypass. This is the whole
  // point of the mode — admins shouldn't be able to peek at someone's
  // private CSV.
  if (row.ownerUserId) {
    return row.ownerUserId === user.id;
  }
  const v = readVisibility(row);
  if (v.mode === "tenant") return true;
  if (v.mode === "roles") {
    if (user.isAdmin) return true; // admin bypass for role-scoped mode
    const mine = new Set(user.roles);
    return v.roles.some((r) => mine.has(r));
  }
  // Should be unreachable given the ownerUserId check above, but the
  // discriminator may evolve.
  return false;
}

/** Filter a list of DataSource rows to only those the user can see. */
export function filterVisibleDataSources<T extends DataSourceAclRow>(
  rows: T[],
  user: { id: string; isAdmin: boolean; roles: string[] },
): T[] {
  return rows.filter((r) => canSeeDataSource(r, user));
}

/**
 * Format the visibility for display chips on the listing UI. Returns a
 * compact label + a subtle descriptor (used by the connection list and
 * the audit log meta).
 */
export function describeVisibility(row: DataSourceAclRow, currentUserId?: string): {
  label: string;
  detail: string;
  mode: Visibility["mode"];
} {
  const v = readVisibility(row);
  if (v.mode === "owner_only") {
    return {
      mode: "owner_only",
      label: row.ownerUserId === currentUserId ? "Just me" : "Private",
      detail: "Only the uploader can see this source.",
    };
  }
  if (v.mode === "roles") {
    return {
      mode: "roles",
      label: v.roles.join(", "),
      detail: "Only users with one of these roles can see this source.",
    };
  }
  return {
    mode: "tenant",
    label: "Tenant",
    detail: "Everyone in this workspace can see this source.",
  };
}
