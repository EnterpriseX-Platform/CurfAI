/**
 * POST /api/workspaces/[id]/deletion/cancel — withdraw a requested deletion during the grace period.
 *
 * The workspace is closed, so the caller is, by definition, signed in through another workspace; what authorizes them is
 * a REAL admin membership in this one (not an organization-oversight virtual one). Cancelling restores the workspace to
 * what it was before the request (lib/lifecycle/deletion.ts).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { LifecycleError, cancelDeletion } from "@/lib/lifecycle/deletion";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.viaApiKey) return NextResponse.json({ error: "Session required" }, { status: 403 });

  const m = (user.memberships ?? []).find((x) => !x.isVirtual && x.tenantId === params.id);
  if (!m || m.role !== "admin") return NextResponse.json({ error: "Only an admin of this workspace can cancel its deletion" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  try {
    const r = await cancelDeletion(params.id, { email: user.email, id: user.id }, { reason: typeof body?.reason === "string" ? body.reason.slice(0, 500) : undefined });
    return NextResponse.json({ ok: true, restoredTo: r.restoredTo });
  } catch (e) {
    if (e instanceof LifecycleError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
