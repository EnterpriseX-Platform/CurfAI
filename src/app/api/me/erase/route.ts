/**
 * POST /api/me/erase — erase the caller's own account (PDPA / GDPR erasure request).
 *
 * Irreversible, so: a session (never an API key), the account's email typed back, the current password too when the
 * account has one (an account that signs in only through SSO has none), and a rate limit. GET returns what would stand in
 * the way, so the page can say so before the person types anything. What erasure does and does not do is in
 * lib/lifecycle/person.ts; the request is logged either way (DataSubjectRequest).
 */
import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { withSystemDbContext } from "@/lib/dbContext";
import { rateLimit } from "@/lib/rateLimit";
import { LifecycleError } from "@/lib/lifecycle/deletion";
import { closeRequest, erasePerson, erasureBlockers, openRequest } from "@/lib/lifecycle/person";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.viaApiKey) return NextResponse.json({ error: "Session required" }, { status: 403 });
  const u = await withSystemDbContext(() => prisma.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } }));
  return NextResponse.json({ blockers: await erasureBlockers(user.id), needsPassword: !!u?.passwordHash });
}

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.viaApiKey) return NextResponse.json({ error: "Session required" }, { status: 403 });
  if (!(await rateLimit(`me-erase:${user.id}`, 5, 3_600_000)).ok) return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body.confirmEmail !== "string" || body.confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
    return NextResponse.json({ error: "Type your account email to confirm" }, { status: 400 });
  }
  const row = await withSystemDbContext(() => prisma.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } }));
  if (row?.passwordHash) {
    const ok = typeof body.password === "string" && body.password.length > 0 && (await bcrypt.compare(body.password, row.passwordHash));
    if (!ok) return NextResponse.json({ error: "Incorrect password" }, { status: 403 });
  }

  const dsr = await openRequest({ kind: "erasure", subjectEmail: user.email, subjectUserId: user.id, channel: "self_service" });
  try {
    const r = await erasePerson(user.id, { email: user.email, id: user.id }, { requestId: dsr.id });
    await closeRequest(dsr.id, "completed", user.email);
    return NextResponse.json({ ok: true, workspacesScheduledForDeletion: r.workspacesScheduledForDeletion.length });
  } catch (e: any) {
    // A refusal (the only admin of a shared workspace, an active subscription) is a closed request with its reason, not a failure of ours.
    const refused = e instanceof LifecycleError;
    await closeRequest(dsr.id, refused ? "rejected" : "failed", user.email, String(e?.message ?? e).slice(0, 500)).catch(() => null);
    if (refused) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
