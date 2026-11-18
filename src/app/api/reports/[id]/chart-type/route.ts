/**
 * POST /api/reports/[id]/chart-type — keep the chart type a reader picked in
 * the viewer's "view as" menu, for everyone. Body: { blockId, chartType }.
 *
 * The viewer only holds the definition the reader may see (role-gated blocks
 * removed), so the change is made here on the stored definition, one block,
 * never by sending a whole definition back. Editors and admins only, like any
 * report save; a gated chart type needs its plan (chartTypeGates.ts). The
 * definition before is kept as a ReportVersion and the change is audited in
 * the same transaction.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdminOrEditor, requireReportInScope, reportWhere } from "@/lib/auth";
import { persistAuditIn } from "@/lib/audit";
import { featureGate } from "@/lib/featureGate";
import { ChartConfigSchema, ReportSchema } from "@/lib/reporting/schema";
import { GATED_CHART_TYPES } from "@/lib/reporting/chartTypeGates";

const BodySchema = z.object({
  blockId: z.string().min(1).max(120),
  chartType: ChartConfigSchema.shape.chartType,
});

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Invalid request", issues: body.error.issues }, { status: 400 });
  const { blockId, chartType } = body.data;

  const row = await prisma.report.findFirst({ where: { ...reportWhere(user), id: params.id } });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parsed = ReportSchema.safeParse(JSON.parse(row.definition));
  if (!parsed.success) return NextResponse.json({ error: "The saved report no longer validates; open it in the designer" }, { status: 409 });
  const definition = parsed.data;
  const block = definition.pages.flatMap((p) => p.blocks).find((b) => b.id === blockId);
  if (!block || block.type !== "chart") return NextResponse.json({ error: "No chart with that id in this report" }, { status: 404 });

  const from = block.config.chartType;
  if (from === chartType) return NextResponse.json({ ok: true, version: row.version, unchanged: true });
  const gatedKey = GATED_CHART_TYPES[chartType];
  if (gatedKey) {
    const gate = await featureGate(user, gatedKey);
    if (gate) return gate;
  }
  block.config.chartType = chartType;

  const version = row.version ?? 1;
  try {
    await prisma.$transaction(async (tx) => {
      // Audit first, in the same transaction: if it can't be written, nothing changes.
      await persistAuditIn(tx, { user, kind: "report.update", target: row.id, req, meta: { name: row.name, blockId, chartType: { from, to: chartType }, version: version + 1 } });
      const r = await tx.report.updateMany({ where: { id: row.id, tenantId: user.tenantId, version }, data: { definition: JSON.stringify(definition), version: version + 1 } });
      // Someone saved the report in between: throw so the audit row rolls back with it.
      if (r.count !== 1) throw new EditedMeanwhile();
      await tx.reportVersion.create({ data: { tenantId: user.tenantId, reportId: row.id, version, definition: row.definition, note: `Before chart type ${from} -> ${chartType} (${blockId})`, createdById: user.id } });
    });
  } catch (e) {
    if (e instanceof EditedMeanwhile) return NextResponse.json({ error: "The report changed while saving; reload and try again" }, { status: 409 });
    throw e;
  }
  return NextResponse.json({ ok: true, version: version + 1 });
}

class EditedMeanwhile extends Error {}
