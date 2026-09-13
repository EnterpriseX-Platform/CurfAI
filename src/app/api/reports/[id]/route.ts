import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ReportSchema } from "@/lib/reporting/schema";
import { requireUser, requireAdminOrEditor, requireReportInScope } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { ee } from "@/ee";
import { featureGate } from "@/lib/featureGate";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;
  const report = await prisma.report.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
  });
  if (!report) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({
    id: report.id,
    name: report.name,
    definition: JSON.parse(report.definition),
    version: report.version,
    published: report.published,
  });
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;

  const existing = await prisma.report.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
    select: { id: true, name: true },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const parsed = ReportSchema.safeParse(body.definition);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid report", issues: parsed.error.issues }, { status: 400 });
  }

  const r = parsed.data;

  // Tier-gated content checks. We refuse to *persist* configurations that
  // require a higher tier than the tenant has. Reads stay unrestricted —
  // a downgraded tenant still sees their themed/formatted reports until
  // they re-save. Each gate emits a 402 with featureLabel so the client
  // can surface a targeted upgrade toast.
  if (r.theme && r.theme !== "default") {
    const block = await featureGate(user, "viz.theme_presets");
    if (block) return block;
  }
  // Conditional table formatting is gated when any table column has a
  // non-trivial conditional config (heatmap, bar, or rules).
  const hasConditional = r.pages.some((p) =>
    p.blocks.some((b) =>
      b.type === "table" && (b.config as any).columns?.some((c: any) =>
        c.conditional && (
          (c.conditional.heatmap && c.conditional.heatmap !== "off") ||
          c.conditional.bar ||
          (c.conditional.rules && c.conditional.rules.length > 0)
        )
      )
    )
  );
  if (hasConditional) {
    const block = await featureGate(user, "viz.conditional_table");
    if (block) return block;
  }
  // Annotations on charts (free for everyone — no gate). We still scan to
  // keep the validation symmetric, but no gate is invoked.

  // Gated chart types — Tier 2 viz roadmap. We refuse to persist a report
  // that uses gauge/waterfall/bullet/sankey on a non-Team tenant. Same
  // pattern as theme/conditional: viewer reads stay open, save is gated.
  const GATED_CHART_TYPES: Record<string, "viz.chart.gauge" | "viz.chart.waterfall" | "viz.chart.bullet" | "viz.chart.sankey"> = {
    gauge:     "viz.chart.gauge",
    waterfall: "viz.chart.waterfall",
    bullet:    "viz.chart.bullet",
    sankey:    "viz.chart.sankey",
  };
  const usedGatedTypes = new Set<string>();
  for (const p of r.pages) {
    for (const b of p.blocks) {
      if (b.type === "chart") {
        const ct = (b.config as any).chartType;
        if (ct && GATED_CHART_TYPES[ct]) usedGatedTypes.add(ct);
      }
    }
  }
  for (const ct of usedGatedTypes) {
    const block = await featureGate(user, GATED_CHART_TYPES[ct]);
    if (block) return block;
  }

  // Forecast — gated by method. Linear and ETS are both pure-JS/deterministic
  // and share the Team gate (ai.forecast_linear); LLM is Business
  // (ai.forecast_llm). We scan once and gate based on the strongest method
  // present in the report.
  let usesLlmForecast = false;
  let usesLinearForecast = false;
  for (const p of r.pages) {
    for (const b of p.blocks) {
      if (b.type === "chart" || b.type === "kpi") {
        const fc = (b.config as any).forecast;
        if (fc?.method === "llm") usesLlmForecast = true;
        else if (fc?.method === "linear" || fc?.method === "ets") usesLinearForecast = true;
      }
    }
  }
  if (usesLlmForecast) {
    const block = await featureGate(user, "ai.forecast_llm");
    if (block) return block;
  }
  if (usesLinearForecast) {
    const block = await featureGate(user, "ai.forecast_linear");
    if (block) return block;
  }

  const updated = await prisma.report.update({
    where: { id: params.id },
    data: {
      name: r.name,
      description: r.description,
      category: r.category,
      definition: JSON.stringify(r),
      version: { increment: 1 },
    },
  });
  // Vector DB (Week 2) — enqueue an embedding refresh so semantic
  // search picks up the new name/description on the next cron tick.
  // Gated on CURF_VECTOR_DB; a failed enqueue must never block the
  // save (see enqueueEmbedIfEnabled).
  await ee.vectorStore?.enqueueEmbedIfEnabled({
    tenantId: user.tenantId,
    kind: "report",
    refId: params.id,
  });
  recordAudit({
    user, kind: "report.update", target: params.id, req,
    meta: {
      name: r.name,
      version: updated.version,
      pages: r.pages.length,
      blocks: r.pages.reduce((s, p) => s + p.blocks.length, 0),
    },
  });
  return NextResponse.json({ id: updated.id, version: updated.version });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;
  const existing = await prisma.report.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
    select: { id: true, name: true },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.report.delete({ where: { id: params.id } });
  recordAudit({
    user, kind: "report.delete", target: params.id, req,
    meta: { name: existing.name },
  });
  return NextResponse.json({ ok: true });
}
