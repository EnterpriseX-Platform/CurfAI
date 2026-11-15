/**
 * GET  /api/workspaces/[id]/exports — a workspace's exports (newest first).
 * POST /api/workspaces/[id]/exports — start a new one (a zip of the workspace's data, built in the background).
 *
 * Authorized by a REAL admin membership in the target workspace, not by the workspace the request is bound to: the
 * exports made when a deletion is requested are read from another workspace, since the closed one can't be signed in to.
 * Session only, never an API key. See lib/lifecycle/export.ts for what the archive holds.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { persistAudit } from "@/lib/audit";
import { withSystemDbContext } from "@/lib/dbContext";
import { rateLimit } from "@/lib/rateLimit";
import { LifecycleError } from "@/lib/lifecycle/deletion";
import { createWorkspaceExport } from "@/lib/lifecycle/export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function realAdmin(req: NextRequest, tenantId: string) {
  const user = await requireUser(req);
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  if (user.viaApiKey) return { error: NextResponse.json({ error: "Session required" }, { status: 403 }) } as const;
  const m = (user.memberships ?? []).find((x) => !x.isVirtual && x.tenantId === tenantId);
  if (!m || m.role !== "admin") return { error: NextResponse.json({ error: "Only an admin of this workspace can export it" }, { status: 403 }) } as const;
  return { user } as const;
}

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const a = await realAdmin(req, params.id);
  if ("error" in a) return a.error;
  const rows = await withSystemDbContext(() => prisma.workspaceExport.findMany({
    where: { tenantId: params.id }, orderBy: { createdAt: "desc" }, take: 20,
    select: { id: true, reason: true, status: true, sizeBytes: true, fileCount: true, error: true, createdAt: true, finishedAt: true, expiresAt: true },
  }));
  return NextResponse.json({ exports: rows });
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const a = await realAdmin(req, params.id);
  if ("error" in a) return a.error;
  if (!(await rateLimit(`ws-export:${a.user.id}`, 5, 3_600_000)).ok) return NextResponse.json({ error: "Too many exports. Try again later." }, { status: 429 });
  try {
    // The audit row first: an export is a copy of everything the workspace holds.
    await withSystemDbContext(() => persistAudit({ user: a.user, tenantId: params.id, kind: "tenant.export.request", target: params.id, req, meta: { reason: "manual" } }));
    const r = await createWorkspaceExport({ tenantId: params.id, requestedBy: a.user.email, reason: "manual" });
    return NextResponse.json({ ok: true, id: r.id }, { status: 202 });
  } catch (e) {
    if (e instanceof LifecycleError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
