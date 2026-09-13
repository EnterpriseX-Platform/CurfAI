import { NextRequest, NextResponse } from "next/server";
import { requireUser, loadMembershipsForEmail } from "@/lib/auth";

/**
 * GET /api/memberships
 *
 * Returns every workspace the signed-in user belongs to. The session
 * already carries this list (it's computed in the JWT callback at signin),
 * but this endpoint is the source of truth for refreshes — call it after
 * accepting an invite or creating a new workspace, then call
 * `useSession().update({ refreshMemberships: true })` to update the JWT.
 */
export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.viaApiKey) return NextResponse.json({ memberships: [] });
  const memberships = await loadMembershipsForEmail(user.email);
  return NextResponse.json({ memberships, activeTenantId: user.tenantId });
}
