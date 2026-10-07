import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { reconcileAll } from "@/lib/engine/attributes";

export const dynamic = "force-dynamic";

/**
 * Makes every engine of the workspace hold exactly what Curf holds, sending only what differs. For an engine that
 * was changed by hand, restored from a backup, or was unreachable when a change was made. Admins only.
 */
export async function POST(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const engines = await reconcileAll(user.tenantId, { id: user.id, isAdmin: true, roles: [] });
  recordAudit({ user, kind: "engine.attribute.sync", target: user.tenantId, req, meta: { engines: engines.length, sent: engines.reduce((n, e) => n + e.entries, 0), failed: engines.filter((e) => !e.ok).length } });
  return NextResponse.json({ engines });
}
