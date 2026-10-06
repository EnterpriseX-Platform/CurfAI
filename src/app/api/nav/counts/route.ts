/**
 * GET /api/nav/counts — every sidebar badge in one answer.
 *
 * The Sidebar mounts on every page. It used to ask a dozen list endpoints
 * for their whole lists only to count them; this resolves the session once
 * and counts each list with the filters its own route applies:
 *   reports     GET /api/reports (reportWhere)
 *   sources     GET /api/data-sources (tenantWhere, then canSeeDataSource)
 *   dashboards  GET /api/dashboards (the same)
 *   onScreen    GET /api/on-screen (the same)
 * plus, outside the Community edition, the paid surfaces' badges
 * (ee.navCounts, src/ee/navCounts.ts). The three visibility-controlled lists
 * read only the two visibility columns: canSeeDataSource's rules (a corrupt
 * roles list means everyone) aren't a WHERE clause.
 *
 * An answer is kept per person for NAV_COUNTS_TTL_MS, so a run of page
 * changes costs one set of counts. `?fresh=1`, sent after refreshNavCounts()
 * (something was just created or deleted), counts again.
 *
 * A report-scoped API key is refused: the counts span far more than its
 * allowlisted reports.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser, reportWhere, tenantWhere, blockScopedApiKey, memberRoleSlugs, type CurfSessionUser } from "@/lib/auth";
import { canSeeDataSource, type DataSourceAclRow } from "@/lib/datasourceAcl";
import { ee } from "@/ee";
import { NAV_COUNTS_TTL_MS, type NavCounts } from "@/lib/navCounts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const kept = new Map<string, { at: number; counts: NavCounts }>();
/** Past this many people kept, expired answers are swept before another is added. */
const MAX_KEPT = 5_000;

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scopeBlock = blockScopedApiKey(user);
  if (scopeBlock) return scopeBlock;

  // Keyed by workspace and person — and role, which decides what's counted
  // (data quality, whose watchers, the visibility rules).
  const key = `${user.tenantId}:${user.id}:${user.role}`;
  const hit = kept.get(key);
  if (hit && Date.now() - hit.at < NAV_COUNTS_TTL_MS && req.nextUrl.searchParams.get("fresh") !== "1") {
    return NextResponse.json(hit.counts);
  }
  const counts = await countAll(user);
  keep(key, counts);
  return NextResponse.json(counts);
}

async function countAll(user: CurfSessionUser): Promise<NavCounts> {
  const tenant = tenantWhere(user);
  const acl = { select: { ownerUserId: true, visibleToRolesJson: true }, where: tenant };
  const [roles, reports, sources, dashboards, onScreen, paid] = await Promise.all([
    aclRoles(user),
    settle(prisma.report.count({ where: reportWhere(user) })),
    settle(prisma.dataSource.findMany(acl)),
    settle(prisma.dashboard.findMany(acl)),
    settle(prisma.onScreenDisplay.findMany(acl)),
    ee.navCounts ? settle(ee.navCounts.paid(user)) : undefined,
  ]);
  const viewer = { id: user.id, isAdmin: user.role === "admin", roles };
  const visible = (rows: DataSourceAclRow[] | undefined) => rows?.filter((r) => canSeeDataSource(r, viewer)).length;
  return {
    ...paid,
    reports,
    sources: visible(sources),
    dashboards: visible(dashboards),
    onScreen: visible(onScreen),
  };
}

/** The role slugs the visibility rules match — getUserRoles(), without resolving the session a second time. */
async function aclRoles(user: CurfSessionUser): Promise<string[]> {
  if (user.viaApiKey) return [];
  const row = await prisma.membership
    .findUnique({ where: { userId_tenantId: { userId: user.id, tenantId: user.tenantId } }, select: { rolesJson: true } })
    .catch(() => null);
  return memberRoleSlugs(user.role, row?.rolesJson);
}

/** A count whose query fails is left out, so its badge stays hidden — as a failed list request left it. */
function settle<T>(p: Promise<T>): Promise<T | undefined> {
  return p.catch(() => undefined);
}

function keep(key: string, counts: NavCounts): void {
  const now = Date.now();
  if (kept.size >= MAX_KEPT) {
    for (const [k, v] of kept) if (now - v.at >= NAV_COUNTS_TTL_MS) kept.delete(k);
    // Still full of live answers: drop the oldest (a Map iterates in insertion order).
    if (kept.size >= MAX_KEPT) kept.delete(kept.keys().next().value as string);
  }
  kept.delete(key);
  kept.set(key, { at: now, counts });
}
