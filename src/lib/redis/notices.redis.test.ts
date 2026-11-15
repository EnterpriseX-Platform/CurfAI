/**
 * Notices between replicas, against a real Redis (skipped unless CURF_TEST_REDIS_URL is set). The other replica is a
 * separate Node process. Covers the three things that use them: a handler, the query-result cache, and a workspace's
 * remembered open/closed status.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const URL = process.env.CURF_TEST_REDIS_URL;
const run = promisify(execFile);
const announce = (topic: string, payload: unknown) =>
  run(process.execPath, ["--import", "tsx", "src/lib/redis/notices.publisher.fixture.ts", topic, JSON.stringify(payload)], {
    env: { ...process.env, CURF_REDIS_URL: URL }, cwd: process.cwd(), timeout: 60_000,
  });
const until = async (check: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return check();
};

describe.skipIf(!URL)("notices between replicas", () => {
  let notices: typeof import("./notices");

  beforeAll(async () => {
    process.env.CURF_REDIS_URL = URL;
    notices = await import("./notices");
  });
  afterAll(async () => {
    const { closeRedis } = await import("./index");
    await closeRedis();
    delete process.env.CURF_REDIS_URL;
  });

  it("delivers another process's notice to a handler, and never echoes its own", async () => {
    const heard: unknown[] = [];
    notices.onNotice("test-topic", (p) => heard.push(p));
    await new Promise((r) => setTimeout(r, 500)); // subscribe
    notices.publishNotice("test-topic", { from: "me" });
    await new Promise((r) => setTimeout(r, 300));
    expect(heard).toEqual([]);
    await announce("test-topic", { from: "other" });
    expect(await until(() => heard.length === 1)).toBe(true);
    expect(heard[0]).toEqual({ from: "other" });
  }, 90_000);

  it("another replica's data change empties this replica's cached query results", async () => {
    const cache = await import("@/lib/reporting/queryCache");
    const q = (dataSourceId: string) => ({ tenantId: "t-notice-cache", dataSourceId, sql: "select 1", params: {} });
    cache.setCachedRows({ ...q("ds-a"), rows: [{ n: 1 }], dataHash: "h" });
    cache.setCachedRows({ ...q("ds-b"), rows: [{ n: 2 }], dataHash: "h" });
    await new Promise((r) => setTimeout(r, 500)); // the handler subscribes when the module loads
    await announce("cache-bust", { tenantId: "t-notice-cache", dataSourceId: "ds-a" });
    expect(await until(() => cache.getCachedRows(q("ds-a")) === null)).toBe(true);
    expect(cache.getCachedRows(q("ds-b"))).not.toBeNull(); // only the named source
    await announce("cache-bust", { tenantId: "t-notice-cache" });
    expect(await until(() => cache.getCachedRows(q("ds-b")) === null)).toBe(true); // the whole workspace
  }, 90_000);

  it("a suspension on another replica is seen here at once, not after the status cache's TTL", async () => {
    const { prisma } = await import("@/lib/db");
    const guard = await import("@/lib/tenantGuard");
    // Stand in for the database: the guard asks Prisma for the workspace's status.
    const row = { status: "active" as string };
    const orig = (prisma as any).tenant.findUnique;
    (prisma as any).tenant.findUnique = async () => ({ id: "t-notice-guard", status: row.status });
    try {
      expect(await guard.tenantIsOpen("t-notice-guard")).toBe(true); // cached as open
      row.status = "suspended";
      expect(await guard.tenantIsOpen("t-notice-guard")).toBe(true); // still the cached answer
      await new Promise((r) => setTimeout(r, 500));
      await announce("tenant-status", { id: "t-notice-guard" }); // what the other replica's forgetTenantStatus sends
      await new Promise((r) => setTimeout(r, 500));
      expect(await guard.tenantIsOpen("t-notice-guard")).toBe(false);
    } finally {
      (prisma as any).tenant.findUnique = orig;
    }
  }, 90_000);
});
