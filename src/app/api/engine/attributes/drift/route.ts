import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { driftReports } from "@/lib/engine/attributes";

export const dynamic = "force-dynamic";

/**
 * Whether each engine of the workspace holds what Curf holds: who is missing on the engine (they would see too
 * little) and who is extra there (they might see rows Curf would not give them). Admins only; read-only.
 */
export async function GET(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;
  return NextResponse.json({ engines: await driftReports(user.tenantId, { id: user.id, isAdmin: true, roles: [] }) });
}
