/**
 * GET /api/v1/reports — list this tenant's reports.
 *
 * Stable public endpoint. Uses the unified requireUser() so it accepts
 * BOTH session cookies (browser-based clients) and `Authorization: Bearer
 * curf_...` API keys (scripts, CI, third-party dashboards).
 *
 * Pagination via ?cursor=<id>&limit=<n> (default 50, max 200).
 * Filter via ?q=<substring> (matches name).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireUser, tenantWhere } from "@/lib/auth";
import { withTenantContext } from "@/lib/rls";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
  const cursor = url.searchParams.get("cursor");
  const q = url.searchParams.get("q")?.trim();

  const where: any = { ...tenantWhere(user) };
  if (q) where.name = { contains: q };
  // Scoped API key (Phase 3.2) — restrict to the key's report allowlist.
  // Undefined for session users and unscoped keys, so existing callers see
  // no change.
  if (user.scopedReportIds) where.id = { in: user.scopedReportIds };

  // withTenantContext sets the Postgres RLS session GUCs so tenant
  // isolation is enforced at the DB layer too, not just this app-level
  // filter — matches the internal /api/reports list route.
  const items = await withTenantContext(user, (tx) =>
    tx.report.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, name: true, description: true, category: true,
        version: true, createdAt: true, updatedAt: true,
      },
    })
  );

  const hasMore = items.length > limit;
  const trimmed = hasMore ? items.slice(0, limit) : items;
  return NextResponse.json({
    data: trimmed,
    nextCursor: hasMore ? trimmed[trimmed.length - 1].id : null,
  });
}
