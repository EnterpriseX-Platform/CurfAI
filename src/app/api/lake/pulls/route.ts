/**
 * /api/lake/pulls
 *   GET   — list scheduled pulls for the tenant (REST or SFTP source)
 *   POST  — create a new scheduled pull (or run-now)
 *
 * Body for POST:
 *   {
 *     name, dataSourceId, tableName, strategy?,
 *     request?: { method, path, body?, jsonPath?, headers? },  // REST source only
 *     cron, runNow?: boolean
 *   }
 *
 * `request` is required when dataSourceId points at a "rest" DataSource,
 * ignored for "sftp" (an SFTP pull has nothing per-run to configure —
 * everything it needs already lives on the connection: host, remotePath,
 * credentials — see lib/connections/sftp.ts).
 *
 * runNow=true triggers the pull immediately after creation so the user
 * sees data in the lake browser without waiting for the next cron tick.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { runLakePull } from "@/lib/lake/restPull";

export const dynamic = "force-dynamic";

const RequestShape = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
  path: z.string().min(1),
  body: z.string().optional(),
  jsonPath: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  dataSourceId: z.string().min(1),
  tableName: z.string().min(1).max(60),
  strategy: z.enum(["append", "replace"]).default("replace"),
  request: RequestShape.optional(),
  cron: z.string().min(5).max(80),
  runNow: z.boolean().optional(),
});

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const items = await prisma.lakePull.findMany({
    where: { tenantId: user.tenantId },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ items });
}

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }

  // Confirm the source DataSource is REST or SFTP + in this tenant.
  const ds = await prisma.dataSource.findFirst({
    where: { id: parsed.data.dataSourceId, tenantId: user.tenantId },
    select: { id: true, kind: true, name: true },
  });
  if (!ds) return NextResponse.json({ error: "Source connection not found" }, { status: 404 });
  if (ds.kind !== "rest" && ds.kind !== "sftp") {
    return NextResponse.json({ error: "Only REST or SFTP connections can pull into the lake" }, { status: 400 });
  }
  if (ds.kind === "rest" && !parsed.data.request) {
    return NextResponse.json({ error: "request is required for a REST source" }, { status: 400 });
  }

  const pull = await prisma.lakePull.create({
    data: {
      tenantId: user.tenantId,
      name: parsed.data.name,
      dataSourceId: parsed.data.dataSourceId,
      tableName: parsed.data.tableName,
      strategy: parsed.data.strategy,
      // SFTP has nothing per-run to configure — {} keeps the column
      // non-null without a schema change (see restPull.ts's dispatch).
      requestJson: JSON.stringify(ds.kind === "rest" ? parsed.data.request : {}),
      cron: parsed.data.cron,
      enabled: true,
      createdById: user.id,
    },
  });
  recordAudit({
    user, kind: "lake.pull.create", target: pull.id, req,
    meta: { name: pull.name, dataSourceId: pull.dataSourceId, tableName: pull.tableName, strategy: pull.strategy },
  });

  let firstRunResult: any = null;
  if (parsed.data.runNow) {
    try { firstRunResult = await runLakePull(pull.id); }
    catch (e: any) { firstRunResult = { status: "failed", error: e?.message }; }
  }

  return NextResponse.json({ pull, firstRunResult });
}
