/**
 * Monthly Master Builder build cap (plans.ts masterBuildsPerMonth), against a db double. Count quotas don't apply in
 * the Community edition (billing.ts COUNT_QUOTAS_APPLY), so each case says what that build expects too.
 */
import { describe, expect, it } from "vitest";
import { requireMasterBuildQuota } from "./billing";
import { EDITION } from "./ee/edition";

function fakeDb(tier: string, started: number) {
  const calls: any[] = [];
  return {
    calls,
    db: {
      tenant: { findUnique: async () => ({ tier }) },
      masterBuild: { count: async (args: any) => { calls.push(args); return started; } },
    } as any,
  };
}
const quotas = EDITION !== "community";

describe("requireMasterBuildQuota", () => {
  it("blocks the 3rd build of the month on the free plan with a 402 and the reset date", async () => {
    const res = await requireMasterBuildQuota("t1", fakeDb("community", 2).db);
    if (!quotas) return expect(res).toBeNull();
    expect(res?.status).toBe(402);
    const body = await res!.json();
    expect(body.code).toBe("master_build_quota");
    expect(body.limit).toBe(2);
    expect(body.resetsAt).toMatch(/-01T00:00:00/);
  });

  it("allows the 2nd, and counts only this workspace's non-draft, non-failed builds since the first of the month", async () => {
    const f = fakeDb("community", 1);
    expect(await requireMasterBuildQuota("t1", f.db)).toBeNull();
    if (!quotas) return;
    expect(f.calls[0].where.tenantId).toBe("t1");
    expect(f.calls[0].where.status).toEqual({ notIn: ["draft", "failed"] });
    expect(f.calls[0].where.startedAt.gte.getUTCDate()).toBe(1);
  });

  it("never limits a paid plan", async () => {
    expect(await requireMasterBuildQuota("t1", fakeDb("growth", 10_000).db)).toBeNull();
  });
});
