import { NextResponse } from "next/server";
import { checkReady } from "@/lib/health";

/**
 * The original combined probe: 200 when the database is reachable, 503 when not. Kept as it was for the image HEALTHCHECK, the
 * canary and anything else already pointed at it. The cluster's probes use the two below instead, because a database blip
 * must take the pod out of the load balancer (ready) without restarting it (live):
 *   /api/health/live   the process is up and serving (never touches the database)
 *   /api/health/ready  the same checks as this route
 *
 * Deliberately NOT guarded by auth - health checks come from infra. The failure body is generic (lib/health.ts).
 */

export const dynamic = "force-dynamic";

export async function GET() {
  const r = await checkReady();
  return NextResponse.json(r.body, { status: r.ok ? 200 : 503 });
}
