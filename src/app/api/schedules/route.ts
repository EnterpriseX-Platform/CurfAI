import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, tenantWhere, requireReportInScope } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

const CreateSchema = z.object({
  reportId: z.string().min(1),
  name: z.string().min(1),
  cron: z.string().min(1),
  format: z.enum(["pdf", "xlsx", "docx", "csv"]).default("pdf"),
  params: z.record(z.unknown()).default({}),
  recipients: z.array(z.string().email()).default([]),
  enabled: z.boolean().default(true),
});

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const reportId = url.searchParams.get("reportId") ?? undefined;
  if (reportId) {
    const scopeBlock = requireReportInScope(user, reportId);
    if (scopeBlock) return scopeBlock;
  }
  const items = await prisma.schedule.findMany({
    where: {
      ...tenantWhere(user),
      ...(reportId ? { reportId } : (user.scopedReportIds ? { reportId: { in: user.scopedReportIds } } : {})),
    },
    orderBy: { createdAt: "desc" },
    include: { report: { select: { name: true } } },
  });
  return NextResponse.json({
    items: items.map((s: any) => ({
      id: s.id,
      name: s.name,
      reportId: s.reportId,
      reportName: s.report.name,
      cron: s.cron,
      format: s.format,
      recipients: JSON.parse(s.recipients) as string[],
      enabled: s.enabled,
      lastRunAt: s.lastRunAt,
      lastStatus: s.lastStatus,
      createdAt: s.createdAt,
    })),
  });
}

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Scheduled delivery is Community (2026-09-13 decision) — no tier gate.
  // Chat channels stay paid via intelligence.brief_delivery in the dispatcher.
  const body = await req.json().catch(() => null);
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });

  const scopeBlock = requireReportInScope(user, parsed.data.reportId);
  if (scopeBlock) return scopeBlock;

  const report = await prisma.report.findFirst({
    where: { id: parsed.data.reportId, ...tenantWhere(user) },
    select: { id: true, createdById: true, name: true },
  });
  if (!report) return NextResponse.json({ error: "Report not found" }, { status: 404 });

  const createdById = user.viaApiKey ? report.createdById : user.id;
  if (!createdById) return NextResponse.json({ error: "No owner available for schedule" }, { status: 500 });

  const created = await prisma.schedule.create({
    data: {
      tenantId: user.tenantId,
      reportId: parsed.data.reportId,
      name: parsed.data.name,
      cron: parsed.data.cron,
      format: parsed.data.format,
      params: JSON.stringify(parsed.data.params),
      recipients: JSON.stringify(parsed.data.recipients),
      enabled: parsed.data.enabled,
      createdById,
    },
  });

  recordAudit({
    user, kind: "schedule.create", target: created.id, req,
    meta: {
      reportId: parsed.data.reportId,
      reportName: report.name,
      cron: parsed.data.cron,
      format: parsed.data.format,
      recipientsCount: parsed.data.recipients.length,
    },
  });

  return NextResponse.json({ id: created.id });
}
