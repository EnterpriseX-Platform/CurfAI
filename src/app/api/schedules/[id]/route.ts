import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser, tenantWhere } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const found = await prisma.schedule.findFirst({
      where: { id: params.id, ...tenantWhere(user) },
      select: { id: true, name: true, reportId: true },
    });
    if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });
    await prisma.schedule.delete({ where: { id: params.id } });
    recordAudit({
      user, kind: "schedule.delete", target: params.id, req,
      meta: { name: found.name, reportId: found.reportId },
    });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Delete failed" }, { status: 400 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  try {
    const found = await prisma.schedule.findFirst({
      where: { id: params.id, ...tenantWhere(user) },
      select: { id: true },
    });
    if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const updated = await prisma.schedule.update({
      where: { id: params.id },
      data: {
        ...(body?.enabled != null && { enabled: !!body.enabled }),
        ...(body?.name && { name: String(body.name) }),
        ...(body?.cron && { cron: String(body.cron) }),
        ...(body?.format && { format: String(body.format) }),
        ...(body?.recipients && Array.isArray(body.recipients) && { recipients: JSON.stringify(body.recipients) }),
      },
    });
    recordAudit({
      user, kind: "schedule.update", target: params.id, req,
      meta: { fields: Object.keys(body ?? {}) },
    });
    return NextResponse.json({ id: updated.id });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Update failed" }, { status: 400 });
  }
}
