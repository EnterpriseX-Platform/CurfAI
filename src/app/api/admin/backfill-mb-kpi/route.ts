/**
 * POST /api/admin/backfill-mb-kpi
 *
 * One-shot: walk every Master Builder-built report and bump its KPI
 * blocks from h=2 (80px row) to h=3 (120px row) so the new KpiBlock
 * padding/centering renders with breathing room. Shifts every block
 * that sits below the KPI row down by 1 row to keep the layout valid.
 *
 * Idempotent — already-patched (h=3) KPI blocks are left alone, so
 * re-running this is a no-op.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const arts: any[] = await (prisma as any).masterBuildArtifact.findMany({
    where: { kind: "report", status: "ok", tenantId: user.tenantId },
  });

  const touched: string[] = [];
  for (const a of arts) {
    if (!a.refId) continue;
    const rep = await prisma.report.findFirst({
      where: { id: a.refId, tenantId: user.tenantId },
      select: { id: true, name: true, definition: true },
    });
    if (!rep) continue;
    let defn: any;
    try { defn = JSON.parse(rep.definition); } catch { continue; }
    let changed = false;
    for (const page of (defn.pages ?? [])) {
      const kpisToBump = (page.blocks ?? []).filter(
        (b: any) => b?.type === "kpi" && (b.h ?? 2) === 2,
      );
      if (kpisToBump.length === 0) continue;
      const kpiBottom = Math.max(
        ...kpisToBump.map((b: any) => (b.y ?? 0) + (b.h ?? 2)),
      );
      for (const b of (page.blocks ?? [])) {
        if (b?.type === "kpi" && (b.h ?? 2) === 2) {
          b.h = 3;
          changed = true;
        } else if ((b?.y ?? 0) >= kpiBottom) {
          b.y = (b.y ?? 0) + 1;
          changed = true;
        }
      }
    }
    if (changed) {
      await prisma.report.update({
        where: { id: rep.id },
        data: { definition: JSON.stringify(defn) },
      });
      touched.push(rep.name);
    }
  }

  return NextResponse.json({ ok: true, count: touched.length, names: touched });
}
