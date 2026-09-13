/**
 * /api/lake/pulls/[id]
 *   POST   — { action: "run" | "toggle" } — manual fire or pause/resume
 *   DELETE — drop the pull (does NOT delete the lake table it writes to)
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { runLakePull } from "@/lib/lake/restPull";

export const dynamic = "force-dynamic";

const ActionSchema = z.object({ action: z.enum(["run", "toggle"]) });

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pull = await prisma.lakePull.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
  });
  if (!pull) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const parsed = ActionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid action" }, { status: 400 });

  if (parsed.data.action === "toggle") {
    const updated = await prisma.lakePull.update({
      where: { id: pull.id },
      data: { enabled: !pull.enabled },
    });
    recordAudit({ user, kind: "lake.pull.toggle", target: pull.id, req, meta: { enabled: updated.enabled } });
    return NextResponse.json({ pull: updated });
  }

  // run-now
  const result = await runLakePull(pull.id);
  recordAudit({ user, kind: "lake.pull.run", target: pull.id, req, meta: result });
  return NextResponse.json({ result });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pull = await prisma.lakePull.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
  });
  if (!pull) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.lakePull.delete({ where: { id: pull.id } });
  recordAudit({ user, kind: "lake.pull.delete", target: pull.id, req, meta: { name: pull.name } });
  return NextResponse.json({ ok: true });
}
