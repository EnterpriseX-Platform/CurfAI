import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isRlsEnabled } from "@/lib/rls";
import { cacheUrl, pingRedis, queueUrl } from "@/lib/redis";

/**
 * Liveness + readiness probe. Hit by every PaaS (Railway, Fly, Render,
 * Kubernetes) to decide whether to keep the container in the load balancer.
 *
 * Semantics:
 *   200 + { status: "ok", db: "ok", rls, uptimeS, version } when DB is reachable.
 *   503 + { status: "degraded", db: "fail", error }    when the DB roundtrip fails.
 *
 * Redis (when configured) is reported, never fatal: the app degrades to in-process limits and waits without it, so a blip
 * in Redis must not pull every pod out of the load balancer. `redis`/`queue` are "off" (not configured), "ok" or "fail".
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
    const [cache, queue] = await Promise.all([
      cacheUrl() ? pingRedis("cache") : null,
      queueUrl() ? pingRedis("queue") : null,
    ]);
    const word = (p: { ok: boolean } | null) => (p === null ? "off" : p.ok ? "ok" : "fail");
    return NextResponse.json({ status: "ok", db: "ok", redis: word(cache), queue: word(queue), rls: isRlsEnabled(), uptimeS, version });
  } catch (e: any) {
    return NextResponse.json(
      { status: "degraded", db: "fail", error: e?.message ?? "db error", uptimeS, version },
      { status: 503 }
    );
  }
}
