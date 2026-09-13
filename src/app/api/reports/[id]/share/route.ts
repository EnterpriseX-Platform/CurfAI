import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, requireAdminOrEditor, requireReportInScope } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

async function ensureOwnsReport(userTenantId: string, reportId: string) {
  const r = await prisma.report.findFirst({
    where: { id: reportId, tenantId: userTenantId },
    select: { id: true, tenantId: true },
  });
  return r;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;
  const report = await ensureOwnsReport(user.tenantId, params.id);
  if (!report) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rows = await prisma.publicShareToken.findMany({
    where: { reportId: params.id, tenantId: user.tenantId },
    orderBy: { createdAt: "desc" },
    select: { id: true, token: true, expiresAt: true, createdAt: true, createdById: true },
  });
  return NextResponse.json({ items: rows });
}

const CreateSchema = z.object({
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;
  const report = await ensureOwnsReport(user.tenantId, params.id);
  if (!report) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });

  const token = randomBytes(32).toString("base64url");
  const expiresAt = parsed.data.expiresInDays
    ? new Date(Date.now() + parsed.data.expiresInDays * 24 * 3600 * 1000)
    : null;

  const created = await prisma.publicShareToken.create({
    data: {
      tenantId: user.tenantId,
      reportId: params.id,
      token,
      expiresAt,
      createdById: user.id,
    },
  });

  recordAudit({
    user, kind: "share.mint", target: params.id, req,
    meta: { tokenId: created.id, expiresAt: expiresAt?.toISOString() ?? null, expiresInDays: parsed.data.expiresInDays ?? null },
  });

  return NextResponse.json({
    id: created.id,
    token: created.token,
    expiresAt: created.expiresAt,
  });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;
  const token = new URL(req.url).searchParams.get("token");
  if (!token) return NextResponse.json({ error: "token required" }, { status: 400 });

  const existing = await prisma.publicShareToken.findFirst({
    where: { token, reportId: params.id, tenantId: user.tenantId },
    select: { id: true },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.publicShareToken.delete({ where: { id: existing.id } });

  recordAudit({
    user, kind: "share.revoke", target: params.id, req,
    meta: { tokenId: existing.id },
  });

  return NextResponse.json({ ok: true });
}
