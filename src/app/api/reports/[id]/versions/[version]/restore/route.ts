import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser, requireAdminOrEditor, tenantWhere, requireReportInScope } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { ReportSchema } from "@/lib/reporting/schema";

export async function POST(req: NextRequest, { params }: { params: { id: string; version: string } }) {
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;

  // Must confirm the report belongs to the caller's tenant BEFORE touching
  // any version row — the restore/update below trusts this check as its
  // only tenant gate.
  const existing = await prisma.report.findFirst({ where: { id: params.id, tenantId: user.tenantId } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const target = await prisma.reportVersion.findFirst({
    where: { reportId: params.id, tenantId: user.tenantId, version: Number(params.version) },
  });
  if (!target) return NextResponse.json({ error: "Version not found" }, { status: 404 });

  // Validate the stored JSON still parses in case the schema has drifted.
  try { ReportSchema.parse(JSON.parse(target.definition)); }
  catch (e: any) {
    return NextResponse.json({ error: `Stored version is no longer valid: ${e?.message}` }, { status: 400 });
  }

  // Snapshot current before restoring (so restore is also reversible).
  await prisma.reportVersion.create({
    data: {
      tenantId: existing.tenantId,
      reportId: existing.id,
      version: existing.version,
      definition: existing.definition,
      createdById: user.id,
      note: `Auto-snapshot before restoring v${target.version}`,
    },
  }).catch(() => { /* ignore */ });

  const updated = await prisma.report.update({
    where: { id: params.id },
    data: {
      definition: target.definition,
      version: { increment: 1 },
    },
  });

  recordAudit({
    user, kind: "report.version.restore", target: params.id, req,
    meta: { restoredFrom: target.version, newVersion: updated.version },
  });

  return NextResponse.json({ id: updated.id, version: updated.version, restoredFrom: target.version });
}
