import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, requireReportInScope } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const PatchSchema = z.object({
  body: z.string().min(1).max(5000).optional(),
  resolved: z.boolean().optional(),
});

async function loadComment(user: { tenantId: string }, params: { id: string; commentId: string }) {
  return prisma.comment.findFirst({
    where: { id: params.commentId, reportId: params.id, tenantId: user.tenantId },
    select: { id: true, authorId: true, resolvedAt: true },
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; commentId: string } }
) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;

  const existing = await loadComment(user, params);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });

  // Only the author (or an admin) can edit the body. Anyone on the tenant can
  // toggle resolved, because "resolve this thread" is a team action.
  const data: { body?: string; resolvedAt?: Date | null } = {};
  if (parsed.data.body !== undefined) {
    if (existing.authorId !== user.id && user.role !== "admin") {
      return NextResponse.json({ error: "Only the author can edit this comment" }, { status: 403 });
    }
    data.body = parsed.data.body;
  }
  if (parsed.data.resolved !== undefined) {
    data.resolvedAt = parsed.data.resolved ? new Date() : null;
  }

  const updated = await prisma.comment.update({
    where: { id: params.commentId },
    data,
    include: { author: { select: { name: true, email: true } } },
  });

  recordAudit({
    user, kind: "report.comment.update", target: params.commentId, req,
    meta: {
      reportId: params.id,
      bodyEdited: parsed.data.body !== undefined,
      resolved: parsed.data.resolved,
    },
  });

  return NextResponse.json({
    id: updated.id,
    body: updated.body,
    resolvedAt: updated.resolvedAt,
    updatedAt: updated.updatedAt,
    author: updated.author ? { name: updated.author.name, email: updated.author.email } : null,
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; commentId: string } }
) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;
  const existing = await loadComment(user, params);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (existing.authorId !== user.id && user.role !== "admin") {
    return NextResponse.json({ error: "Only the author or an admin can delete" }, { status: 403 });
  }
  await prisma.comment.delete({ where: { id: params.commentId } });

  recordAudit({
    user, kind: "report.comment.delete", target: params.commentId, req,
    meta: { reportId: params.id },
  });

  return NextResponse.json({ ok: true });
}
