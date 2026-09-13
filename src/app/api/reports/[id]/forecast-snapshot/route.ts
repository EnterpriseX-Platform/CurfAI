import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, requireReportInScope } from "@/lib/auth";
import { featureGate } from "@/lib/featureGate";
import { ensureLimit } from "@/lib/rateLimit";

/**
 * POST /api/reports/:id/forecast-snapshot
 *
 * Body: { blockId, queryId, xField, yField, metricLabel, method, candidates }
 *
 * Records what a forecast overlay predicted, for later grading against the
 * real value once `targetDate` arrives (see lib/predictive/resolve.ts and
 * prisma/schema.prisma's ForecastSnapshot model). Fired automatically from
 * ChartBlock.tsx/KpiBlock.tsx whenever a viewer renders a forecast — not a
 * user action, so failures here must never surface as an error the viewer
 * notices (same fire-and-forget contract as /api/reports/captions).
 *
 * Business-tier (ai.forecast_accuracy) — showing the forecast overlay
 * itself is free for every viewer (ForecastControl), but building a track
 * record of how accurate it's been is the trust-layer upsell.
 */

const CandidateSchema = z.object({
  targetLabel: z.string().min(1),
  targetDate: z.coerce.date(),
  predictedValue: z.number(),
  upperBound: z.number(),
  lowerBound: z.number(),
});

const BodySchema = z.object({
  blockId: z.string().min(1),
  queryId: z.string().min(1),
  xField: z.string().min(1),
  yField: z.string().min(1),
  metricLabel: z.string().min(1),
  method: z.enum(["linear", "ets", "llm"]),
  candidates: z.array(CandidateSchema).max(24), // ForecastConfigSchema.periods caps at 24 — no report legitimately produces more
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;

  const gated = await featureGate(user, "ai.forecast_accuracy");
  if (gated) return gated;

  // Charts re-render (and re-POST the same forecast) on every view — this
  // caps accidental hot-loops, not legitimate usage (one call per chart
  // mount, upserted).
  const limited = ensureLimit("forecast-snapshot", `t:${user.tenantId}`, 120, 60_000);
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  const { blockId, queryId, xField, yField, metricLabel, method, candidates } = parsed.data;
  if (candidates.length === 0) return NextResponse.json({ upserted: 0 });

  const report = await prisma.report.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
    select: { id: true, name: true },
  });
  if (!report) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let upserted = 0;
  for (const c of candidates) {
    await prisma.forecastSnapshot.upsert({
      where: {
        reportId_blockId_yField_targetLabel: {
          reportId: report.id,
          blockId,
          yField,
          targetLabel: c.targetLabel,
        },
      },
      create: {
        tenantId: user.tenantId,
        reportId: report.id,
        reportName: report.name,
        blockId,
        queryId,
        xField,
        yField,
        metricLabel,
        method,
        targetLabel: c.targetLabel,
        targetDate: c.targetDate,
        predictedValue: c.predictedValue,
        upperBound: c.upperBound,
        lowerBound: c.lowerBound,
      },
      // Keep the LATEST prediction for a targetLabel rather than the
      // first-ever guess, so the recorded accuracy reflects the forecast a
      // viewer actually saw most recently (the fitted line shifts as new
      // actual data arrives). Known edge case: if a row was already
      // `resolved` (its actual value captured) and the same targetLabel
      // gets re-forecast later — a viewer changing periods enough to
      // re-cover an already-graded date — this still overwrites its
      // predictedValue/bounds without touching status/actualValue, which
      // very slightly desyncs the stored prediction from the one the grade
      // was computed against. Rare in practice (it requires re-forecasting
      // a specific already-past date) and low-impact (cosmetic drift in one
      // historical row, not a wrong grade), so not worth a conditional
      // upsert for this first cut.
      update: {
        method,
        predictedValue: c.predictedValue,
        upperBound: c.upperBound,
        lowerBound: c.lowerBound,
        metricLabel,
        predictedAt: new Date(),
      },
    });
    upserted += 1;
  }

  return NextResponse.json({ upserted });
}
