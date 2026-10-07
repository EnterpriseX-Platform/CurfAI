/**
 * Resolving a Curf data source of kind "engine" into what a call to the engine needs: where it is, who is
 * asking, and for which workspace. Every route that talks to an engine on a person's behalf starts here, so
 * the checks that keep it inside the right workspace and the right visibility are written once:
 *
 *   - the data source must belong to the caller's workspace (tenantWhere) and be of kind "engine";
 *   - the caller must be allowed to see it (canSeeDataSource), exactly as for a report run;
 *   - the engine must be set up on this Curf (a signing key).
 *
 * Not found, not an engine, and not visible all answer the same 404, so a connection id someone may not see
 * is not confirmed to exist.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { tenantWhere, type CurfSessionUser } from "@/lib/auth";
import { canSeeDataSource } from "@/lib/datasourceAcl";
import { exportViewer } from "@/lib/reporting/exportCaller";
import { decodeEngineConnection, resolveEngineTarget, type EngineTarget } from "@/lib/connections/engine";
import { engineIdentityConfigured, type EngineViewer } from "@/lib/engine/identity";

export type EngineContext = {
  target: EngineTarget;
  viewer: EngineViewer;
  tenantId: string;
  dataSource: { id: string; name: string };
};

export async function engineContextFor(user: CurfSessionUser, dataSourceId: string): Promise<EngineContext | NextResponse> {
  const row = await prisma.dataSource.findFirst({
    where: { id: dataSourceId, ...tenantWhere(user) },
    select: { id: true, name: true, kind: true, connection: true, ownerUserId: true, visibleToRolesJson: true, tenantId: true },
  });
  const viewer = await exportViewer(user);
  if (!row || row.kind !== "engine" || !canSeeDataSource(row as any, viewer)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!engineIdentityConfigured()) {
    return NextResponse.json({ error: "The Java engine is not set up on this Curf: its operator has to set CURF_ENGINE_SIGNING_KEY." }, { status: 503 });
  }
  let target: EngineTarget;
  try {
    target = resolveEngineTarget(decodeEngineConnection(row.connection));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "This engine connection is not valid." }, { status: 500 });
  }
  return { target, viewer, tenantId: row.tenantId, dataSource: { id: row.id, name: row.name } };
}

/** HTTP status for an answer the engine gave that is not a success, as Curf's own caller should see it. */
export function httpStatusForEngine(engineStatus: number): number {
  if (engineStatus === 403) return 403;
  if (engineStatus === 404) return 404;
  if (engineStatus === 409) return 409;
  if (engineStatus === 422) return 422;
  if (engineStatus === 429) return 429;
  // 401 means Curf and the engine disagree about the key: that is not the caller's doing, nor a missing page.
  return 502;
}
