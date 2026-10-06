import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser, tenantWhere, requireReportInScope } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { canBuild } from "@/lib/roles";

// Viewer and executive sessions and keys are read-only: DELETE drops a
// delivery someone relies on, PATCH can repoint where it emails the report.
// Both look up `kind: "delivery"` only. Watchers, digests and briefs share
// the Schedule table but have their own routes and stricter rules
// (watcher ownership, admin-only digests) that this route mustn't bypass.

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canBuild(user.role)) return NextResponse.json({ error: "Viewer role is read-only" }, { status: 403 });
  try {
    const found = await prisma.schedule.findFirst({
      where: { id: params.id, kind: "delivery", ...tenantWhere(user) },
      select: { id: true, name: true, reportId: true },
    });
    if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const scopeBlock = requireReportInScope(user, found.reportId);
    if (scopeBlock) return scopeBlock;
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
  if (!canBuild(user.role)) return NextResponse.json({ error: "Viewer role is read-only" }, { status: 403 });
  const body = await req.json().catch(() => null);
  try {
    const found = await prisma.schedule.findFirst({
      where: { id: params.id, kind: "delivery", ...tenantWhere(user) },
      select: { id: true, reportId: true },
    });
    if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });
    // A report-scoped key must not repoint (recipients) or alter delivery of
    // a schedule on a report outside its allowlist — the next cron tick
    // would email that report wherever the key said.
    const scopeBlock = requireReportInScope(user, found.reportId);
    if (scopeBlock) return scopeBlock;
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
