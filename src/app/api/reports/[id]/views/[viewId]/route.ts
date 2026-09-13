/**
 * /api/reports/[id]/views/[viewId] — single saved view: PATCH / DELETE / GET.
 *
 * Edit / delete rules:
 *   - The creator can always edit and delete their own views.
 *   - Admins can edit / delete any view in their tenant (housekeeping).
 *   - Anyone in the tenant can READ a public view (mirrors list-route semantics).
 *
 * Promoting a private view to public, or demoting back, counts as an edit and
 * follows the creator/admin rule above. That keeps the workflow predictable —
 * "if you can edit a view, you can also share it."
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, requireReportInScope } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

const PatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullish(),
  /** When omitted, the params blob is left as-is. Pass {} to clear. */
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  isPublic: z.boolean().optional(),
});

async function loadView(user: { tenantId: string }, params: { id: string; viewId: string }) {
  return prisma.savedView.findFirst({
    where: { id: params.viewId, reportId: params.id, tenantId: user.tenantId },
  });
}

function canEdit(view: any, user: { id: string; role: string }): boolean {
  return view.createdById === user.id || user.role === "admin";
}

function canRead(view: any, user: { id: string }): boolean {
  return view.isPublic === true || view.createdById === user.id;
}

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) ?? {}; } catch { return {}; }
}

export async function GET(req: NextRequest, { params }: { params: { id: string; viewId: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;
  const view = await loadView(user, params);
  if (!view) return NextResponse.json({ error: "View not found" }, { status: 404 });
  if (!canRead(view, user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json({
    view: { ...view, params: safeParse(view.paramsJson), mine: view.createdById === user.id },
  });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string; viewId: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;

  const view = await loadView(user, params);
  if (!view) return NextResponse.json({ error: "View not found" }, { status: 404 });
  if (!canEdit(view, user)) {
    return NextResponse.json({ error: "Only the creator or an admin can edit this view." }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }

  const data: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.description !== undefined) data.description = parsed.data.description ?? null;
  if (parsed.data.params !== undefined) data.paramsJson = JSON.stringify(parsed.data.params);
  if (parsed.data.isPublic !== undefined) data.isPublic = parsed.data.isPublic;

  try {
    const updated = await prisma.savedView.update({
      where: { id: view.id },
      data,
    });
    recordAudit({ user, kind: "view.update", target: updated.id, req, meta: { name: updated.name, reportId: params.id } });
    return NextResponse.json({
      ok: true,
      view: { ...updated, params: safeParse(updated.paramsJson), mine: updated.createdById === user.id },
    });
  } catch (e: any) {
    if (e?.code === "P2002") {
      return NextResponse.json({ error: "A view with that name already exists for this report." }, { status: 400 });
    }
    return NextResponse.json({ error: e?.message ?? "Update failed" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string; viewId: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;

  const view = await loadView(user, params);
  if (!view) return NextResponse.json({ error: "View not found" }, { status: 404 });
  if (!canEdit(view, user)) {
    return NextResponse.json({ error: "Only the creator or an admin can delete this view." }, { status: 403 });
  }
  await prisma.savedView.delete({ where: { id: view.id } });
  recordAudit({ user, kind: "view.delete", target: view.id, req, meta: { name: view.name, reportId: params.id } });
  return NextResponse.json({ ok: true });
}
