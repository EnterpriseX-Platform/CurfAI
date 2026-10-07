import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { engineContextFor } from "@/lib/engine/dataSource";
import { checkEngine } from "@/lib/engine/status";

export const dynamic = "force-dynamic";

const Body = z.object({ dataSourceId: z.string().min(1) });

/**
 * "Test connection" for an engine data source: whether the engine is reachable, accepts Curf's token, puts this
 * person in this workspace, and how many views they can use. Admins only, like managing the connection.
 */
export async function POST(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "dataSourceId is required" }, { status: 400 });

  const ctx = await engineContextFor(user, parsed.data.dataSourceId);
  if (ctx instanceof NextResponse) return ctx;

  const status = await checkEngine(ctx);
  // Who probed which engine connection, and whether it answered: useful when an engine is later found misconfigured.
  recordAudit({ user, kind: "engine.test", target: ctx.dataSource.id, req, meta: { ok: status.ok, source: status.source } });
  return NextResponse.json({ dataSource: ctx.dataSource, status });
}
