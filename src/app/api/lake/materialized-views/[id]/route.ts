/**
 * /api/lake/materialized-views/[id]
 *   POST { action: "refresh" | "toggle" } — recompute or pause/resume
 *   DELETE — drop the MV row + the cached lake table
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { refreshMaterializedView, mvTableName } from "@/lib/lake/materialize";
import { dropTable } from "@/lib/lake/tables";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ActionSchema = z.object({ action: z.enum(["refresh", "toggle"]) });

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const mv = await prisma.materializedView.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
  });
  if (!mv) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const parsed = ActionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid action" }, { status: 400 });

  if (parsed.data.action === "toggle") {
    const updated = await prisma.materializedView.update({
      where: { id: mv.id },
      data: { enabled: !mv.enabled },
    });
    recordAudit({ user, kind: "lake.mv.toggle", target: mv.id, req, meta: { enabled: updated.enabled } });
    return NextResponse.json({ mv: updated });
  }

  // refresh
  const result = await refreshMaterializedView(mv.id);
  recordAudit({ user, kind: "lake.mv.refresh", target: mv.id, req, meta: result });
  return NextResponse.json({ result });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const mv = await prisma.materializedView.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
  });
  if (!mv) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Drop the cached lake table (if it exists) before deleting the MV
  // row. Best-effort — a stale lake row is recoverable on next refresh.
  try { dropTable(user.tenantId, mvTableName(mv.name)); } catch { /* fine */ }
  await prisma.lakeTable.deleteMany({
    where: { tenantId: user.tenantId, name: mvTableName(mv.name) },
  }).catch(() => null);

  await prisma.materializedView.delete({ where: { id: mv.id } });
  recordAudit({ user, kind: "lake.mv.delete", target: mv.id, req, meta: { name: mv.name } });
  return NextResponse.json({ ok: true });
}
