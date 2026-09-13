import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isRlsEnabled } from "@/lib/rls";

/**
 * Liveness + readiness probe. Hit by every PaaS (Railway, Fly, Render,
 * Kubernetes) to decide whether to keep the container in the load balancer.
 *
 * Semantics:
 *   200 + { status: "ok", db: "ok", rls, uptimeS, version } when DB is reachable.
 *   503 + { status: "degraded", db: "fail", error }    when the DB roundtrip fails.
 *
 * Deliberately NOT guarded by auth - health checks come from infra.
 */

export const dynamic = "force-dynamic";
const BOOT = Date.now();

export async function GET() {
  const version = process.env.npm_package_version ?? "0.1.0";
  const uptimeS = Math.floor((Date.now() - BOOT) / 1000);

  try {
    await prisma.$queryRaw`SELECT 1 as ok`;
    return NextResponse.json({ status: "ok", db: "ok", rls: isRlsEnabled(), uptimeS, version });
  } catch (e: any) {
    return NextResponse.json(
      { status: "degraded", db: "fail", error: e?.message ?? "db error", uptimeS, version },
      { status: 503 }
    );
  }
}
