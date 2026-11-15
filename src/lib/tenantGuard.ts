/**
 * "Is this workspace open?" for the places that have a workspace id but no signed-in member: a public share or embed link,
 * a kiosk token, an ingest token, a Slack or LINE event, a SCIM call, and the background jobs.
 *
 * The signed-in paths already ask this through the session and API-key checks in lib/auth.ts. Everything else resolves a
 * workspace from a token, a slug or a row it is working through, runs outside any session, and — under row-level security —
 * in the system context, so nothing in the database stops it. A suspended or pending-deletion workspace
 * (lib/tenantStatus.ts) has to be refused in code, at each of those places, with this one question.
 *
 * Answers are cached for a few seconds so a public page that is hit hard doesn't read the Tenant table on every request.
 * The cache is per process: a change made in this process is visible at once (forgetTenantStatus), one made in another
 * replica within TTL_MS. That is the longest a closed workspace's public link can keep working after the change.
 */
import { prisma } from "@/lib/db";
import { withSystemDbContext } from "@/lib/dbContext";
import { tenantOpen } from "@/lib/tenantStatus";
import { onNotice, publishNotice } from "@/lib/redis/notices";

export const TTL_MS = 15_000;

type Cache = { byId: Map<string, { open: boolean; at: number }>; closed: { ids: string[]; at: number } | null };
const g = globalThis as unknown as { __curfTenantGuard?: Cache };
function cache(): Cache {
  return (g.__curfTenantGuard ??= { byId: new Map(), closed: null });
}

/**
 * Whether the workspace exists and is open. An id that matches no workspace (already purged, never existed) is not open.
 * A database error is not swallowed — a guard that answers "open" because it could not look is no guard.
 */
export async function tenantIsOpen(tenantId: string | null | undefined): Promise<boolean> {
  if (!tenantId) return false;
  const c = cache();
  const hit = c.byId.get(tenantId);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.open;
  const row = await withSystemDbContext(() => prisma.tenant.findUnique({ where: { id: tenantId }, select: { status: true } }));
  const open = !!row && tenantOpen(row.status);
  if (c.byId.size > 5000) c.byId.clear(); // a bound, not an eviction policy: the cache is a few seconds deep anyway
  c.byId.set(tenantId, { open, at: now });
  return open;
}

/**
 * Ids of every workspace that is not open, for a background job to leave out: `tenantId: { notIn: await closedTenantIds() }`.
 * Usually a handful, so this is a better filter than a relation join for models that have no relation to Tenant.
 */
export async function closedTenantIds(): Promise<string[]> {
  const c = cache();
  const now = Date.now();
  if (c.closed && now - c.closed.at < TTL_MS) return c.closed.ids;
  const rows = await withSystemDbContext(() => prisma.tenant.findMany({ where: { status: { not: "active" } }, select: { id: true } }));
  c.closed = { ids: rows.map((r) => r.id), at: now };
  return c.closed.ids;
}

function forgetLocal(tenantId?: string): void {
  const c = cache();
  if (tenantId) c.byId.delete(tenantId); else c.byId.clear();
  c.closed = null;
}

/**
 * Drop what is remembered about one workspace (or all), after its status has changed in this process. With Redis configured
 * the other replicas are told too, so a suspension takes effect everywhere at once instead of after TTL_MS.
 */
export function forgetTenantStatus(tenantId?: string): void {
  forgetLocal(tenantId);
  publishNotice("tenant-status", { id: tenantId ?? null });
}

onNotice("tenant-status", (p: { id: string | null }) => forgetLocal(p?.id ?? undefined));
