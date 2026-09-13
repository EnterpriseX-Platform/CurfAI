/**
 * POST /api/admin/cache/reset
 *
 * Resets the per-tenant query result cache counters (hits, misses, bytes
 * served, ms saved) without clearing cached row data. Used by the "Reset
 * metrics" button on /admin/usage to give admins a clean baseline after
 * a deploy or experiment.
 *
 * Auth: admin-only. The reset is scoped to the calling tenant, so it
 * never affects another workspace's metrics on the same node.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireUser, requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { resetCacheMetrics } from "@/lib/reporting/queryCache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  resetCacheMetrics(user.tenantId);
  recordAudit({ user, kind: "cache.metrics_reset", target: user.tenantId, req });
  return NextResponse.json({ ok: true });
}
