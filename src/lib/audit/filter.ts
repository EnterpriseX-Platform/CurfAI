/**
 * The audit explorer's filters (/admin/audit), shared by the page and its
 * CSV export so a download holds exactly the rows the page was showing.
 * The caller supplies the tenant scope (tenantWhere); this adds the rest.
 */
export type AuditWindow = "24h" | "7d" | "30d" | "all";
export type AuditFilter = { kind: string; family: string; user: string; target: string; window: AuditWindow };

const WINDOWS: AuditWindow[] = ["24h", "7d", "30d", "all"];
const DAY_MS = 86_400_000;

export function readAuditFilter(get: (key: string) => string | null | undefined): AuditFilter {
  const window = get("window") as AuditWindow;
  return {
    kind: get("kind") ?? "",
    family: get("family") ?? "",
    user: get("user") ?? "",
    target: get("target") ?? "",
    window: WINDOWS.includes(window) ? window : "7d",
  };
}

/** The Prisma `where` for these filters, on top of the caller's tenant scope. */
export function auditFilterWhere(f: AuditFilter, now = Date.now()): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (f.kind) where.kind = f.kind;
  // A family chip counts kinds by the part before the dot, so "signin" holds
  // signin itself as well as signin.failed.
  else if (f.family) where.OR = [{ kind: f.family }, { kind: { startsWith: f.family + "." } }];
  if (f.user) where.userEmail = { contains: f.user };
  if (f.target) where.target = { contains: f.target };
  if (f.window !== "all") {
    const days = f.window === "24h" ? 1 : f.window === "30d" ? 30 : 7;
    where.createdAt = { gte: new Date(now - days * DAY_MS) };
  }
  return where;
}

/** The same filters as a query string, for a link that keeps them. */
export function auditFilterQuery(f: AuditFilter): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) usp.set(k, v);
  return usp.toString();
}
