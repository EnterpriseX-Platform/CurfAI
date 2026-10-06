/**
 * /api/lake/materialized-views — CRUD + refresh trigger for MVs.
 *
 *   GET   — list this tenant's materialized views
 *   POST  — create a new MV (with optional runNow=true)
 *
 * Per-MV operations live at /[id]/route.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { blockScopedApiKey, requireUser, requireAdminOrEditor } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { refreshMaterializedView } from "@/lib/lake/materialize";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scoped = blockScopedApiKey(user);
  if (scoped) return scoped;
  const items = await prisma.materializedView.findMany({
    where: { tenantId: user.tenantId },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ items });
}

const CreateSchema = z.object({
  name: z.string().min(1).max(60).regex(/^[a-zA-Z][a-zA-Z0-9_ ]*$/, "Letters, digits, underscores, spaces — start with a letter"),
  sql: z.string().min(10).max(10_000),
  dataSourceId: z.string().min(1),
  cron: z.string().min(5).max(80).optional(),
  runNow: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => ({}));
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });

  // Confirm the source DataSource is in the tenant.
  const ds = await prisma.dataSource.findFirst({
    where: { id: parsed.data.dataSourceId, tenantId: user.tenantId },
    select: { id: true, name: true },
  });
  if (!ds) return NextResponse.json({ error: "Source connection not found" }, { status: 404 });

  let mv;
  try {
    mv = await prisma.materializedView.create({
      data: {
        tenantId: user.tenantId,
        name: parsed.data.name,
        sql: parsed.data.sql,
        dataSourceId: parsed.data.dataSourceId,
        cron: parsed.data.cron ?? null,
        enabled: true,
        lastStatus: "never_run",
        createdById: user.id,
      },
    });
  } catch (e: any) {
    // @@unique([tenantId, name]) — a plain, expected user action (typing a
    // name that's already taken), not caught before this session's live
    // testing turned it up as an uncaught PrismaClientKnownRequestError
    // and an empty 500. Same pattern as the sibling lake routes (e.g.
    // parquet-exports) already use for their own unique constraints.
    if (String(e?.code) === "P2002") {
      return NextResponse.json({ error: `A materialized view named "${parsed.data.name}" already exists.` }, { status: 409 });
    }
    return NextResponse.json({ error: e?.message ?? "Create failed" }, { status: 500 });
  }
  recordAudit({
    user, kind: "lake.mv.create", target: mv.id, req,
    meta: { name: mv.name, dataSourceId: mv.dataSourceId, cron: mv.cron },
  });

  let firstRun: any = null;
  if (parsed.data.runNow) {
    try { firstRun = await refreshMaterializedView(mv.id); }
    catch (e: any) { firstRun = { status: "failed", error: e?.message }; }
  }

  return NextResponse.json({ mv, firstRun });
}
