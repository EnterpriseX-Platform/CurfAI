/**
 * /api/reports/[id]/views — list + create saved views.
 *
 * Visibility model:
 *   - Public views: visible to everyone in the tenant
 *   - Private views: visible only to the creator
 *
 * That's the simplest model that covers the real workflow ("I want to share
 * this with the team" vs "this is just for me"). Per-user share grants
 * (this view shared with X but not Y) is a Stage-2 concern.
 *
 * No tier gate. Saved views are a viewer ergonomic — they shouldn't be
 * locked behind a paywall.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, requireReportInScope } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  /** Map of param name → value, as set in the report's current URL state. */
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  /** Workspace-shared (true) or personal (false). Defaults to personal. */
  isPublic: z.boolean().default(false),
});

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;
  const items = await prisma.savedView.findMany({
    where: {
      tenantId: user.tenantId,
      reportId: params.id,
      OR: [{ isPublic: true }, { createdById: user.id }],
    },
    orderBy: [{ isPublic: "desc" }, { updatedAt: "desc" }],
  });
  return NextResponse.json({
    items: items.map((v: any) => ({
      ...v,
      params: safeParse(v.paramsJson),
      mine: v.createdById === user.id,
    })),
  });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scopeBlock = requireReportInScope(user, params.id);
  if (scopeBlock) return scopeBlock;

  const body = await req.json().catch(() => ({}));
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }
  // Confirm the report exists in this tenant.
  const report = await prisma.report.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
    select: { id: true },
  });
  if (!report) return NextResponse.json({ error: "Report not found" }, { status: 404 });

  try {
    const created = await prisma.savedView.create({
      data: {
        tenantId: user.tenantId,
        reportId: params.id,
        name: parsed.data.name,
        description: parsed.data.description,
        paramsJson: JSON.stringify(parsed.data.params),
        isPublic: parsed.data.isPublic,
        createdById: user.id,
      },
    });
    recordAudit({ user, kind: "view.create", target: created.id, req, meta: { name: created.name, reportId: params.id, isPublic: created.isPublic } });
    return NextResponse.json({ ok: true, view: { ...created, params: parsed.data.params, mine: true } });
  } catch (e: any) {
    if (e?.code === "P2002") {
      return NextResponse.json({ error: "A view with that name already exists for this report." }, { status: 400 });
    }
    return NextResponse.json({ error: e?.message ?? "Save failed" }, { status: 500 });
  }
}

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) ?? {}; } catch { return {}; }
}
