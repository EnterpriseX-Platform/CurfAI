/**
 * /api/snippets/[id] — read / update / delete one snippet.
 *
 * Tenant-scoped. We deliberately do NOT scope to createdById — snippets
 * are a shared workspace asset, so any member can edit. (Audit log keeps a
 * trail; future RBAC slice can scope edits to admins or original authors.)
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

const UpdateSchema = z.object({
  name:        z.string().min(1).max(120).optional(),
  body:        z.string().min(1).optional(),
  description: z.string().max(500).optional(),
  tags:        z.array(z.string()).max(10).optional(),
});

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const row = await prisma.snippet.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ snippet: { ...row, tags: safeParseTags(row.tagsJson) } });
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid snippet", issues: parsed.error.issues }, { status: 400 });
  }
  const existing = await prisma.snippet.findFirst({ where: { id: params.id, tenantId: user.tenantId } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const data: any = { ...parsed.data };
  if (parsed.data.tags) { data.tagsJson = JSON.stringify(parsed.data.tags); delete data.tags; }
  await prisma.snippet.update({ where: { id: params.id }, data });
  recordAudit({ user, kind: "snippet.update", target: params.id, req, meta: { name: existing.name } });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const existing = await prisma.snippet.findFirst({ where: { id: params.id, tenantId: user.tenantId } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.snippet.delete({ where: { id: params.id } });
  recordAudit({ user, kind: "snippet.delete", target: params.id, req, meta: { name: existing.name } });
  return NextResponse.json({ ok: true });
}

function safeParseTags(json: string): string[] {
  try { return JSON.parse(json) ?? []; } catch { return []; }
}
