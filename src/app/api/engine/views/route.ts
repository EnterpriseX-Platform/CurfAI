import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { engineContextFor, httpStatusForEngine } from "@/lib/engine/dataSource";
import { EngineCatalogueError, loadCatalogue } from "@/lib/engine/catalogue";

export const dynamic = "force-dynamic";

/**
 * The views this person can build a report on, from the engine behind one engine data source, as the engine
 * shows them to THIS person: published views they may query, with their columns and whether each comes back
 * masked for them. No SQL, row rules or role lists. Used by the report designer's query panel.
 */
export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const dataSourceId = new URL(req.url).searchParams.get("dataSourceId");
  if (!dataSourceId) return NextResponse.json({ error: "dataSourceId is required" }, { status: 400 });

  const ctx = await engineContextFor(user, dataSourceId);
  if (ctx instanceof NextResponse) return ctx;

  try {
    const views = await loadCatalogue(ctx);
    return NextResponse.json({ dataSource: ctx.dataSource, views });
  } catch (e: any) {
    const status = e instanceof EngineCatalogueError ? httpStatusForEngine(e.engineStatus) : 502;
    return NextResponse.json({ error: e?.message ?? "The engine could not list its views." }, { status });
  }
}
