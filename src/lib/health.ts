/**
 * What "ready" means: the database answers (fatal) and, when configured, Redis answers (reported, never fatal — the app
 * degrades to in-process limits and waits without it, so a blip there must not pull every pod out of the load balancer).
 * Shared by /api/health (the old combined probe, kept for the image HEALTHCHECK and the canary) and /api/health/ready.
 * The failure body is generic on purpose: these routes are anonymous, and a raw database error names hosts, roles and tables.
 * The detail goes to the log, under the request id.
 */
import { prisma } from "@/lib/db";
import { isRlsEnabled } from "@/lib/rls";
import { cacheUrl, pingRedis, queueUrl } from "@/lib/redis";
import { log } from "@/lib/log";

const BOOT = Date.now();
export const uptimeS = () => Math.floor((Date.now() - BOOT) / 1000);
export const appVersion = () => process.env.npm_package_version ?? "0.1.0";

export type Readiness =
  | { ok: true; body: { status: "ok"; db: "ok"; redis: string; queue: string; rls: boolean; uptimeS: number; version: string } }
  | { ok: false; body: { status: "degraded"; db: "fail"; uptimeS: number; version: string } };

/** A database that hangs (a paused node, a lost route) must answer "not ready" within the probe's own timeout, not hold the request open. */
const DB_TIMEOUT_MS = 3_000;

export async function checkReady(): Promise<Readiness> {
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1 as ok`,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("database did not answer in time")), DB_TIMEOUT_MS).unref()),
    ]);
    const [cache, queue] = await Promise.all([
      cacheUrl() ? pingRedis("cache") : null,
      queueUrl() ? pingRedis("queue") : null,
    ]);
    const word = (p: { ok: boolean } | null) => (p === null ? "off" : p.ok ? "ok" : "fail");
    return { ok: true, body: { status: "ok", db: "ok", redis: word(cache), queue: word(queue), rls: isRlsEnabled(), uptimeS: uptimeS(), version: appVersion() } };
  } catch (e) {
    log.warn("readiness check failed: database did not answer", { err: e });
    return { ok: false, body: { status: "degraded", db: "fail", uptimeS: uptimeS(), version: appVersion() } };
  }
}
