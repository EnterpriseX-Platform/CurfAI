/**
 * Public share link cap (plans.ts shareLinksMax), against a db double.
 * Count quotas don't apply in the Community edition (billing.ts
 * COUNT_QUOTAS_APPLY), so each case says what that build expects too.
 */
import { describe, expect, it } from "vitest";
import { requireShareLinkQuota } from "./billing";
import { EDITION } from "./ee/edition";

const user = { id: "u1", tenantId: "t1", role: "admin" } as any;
function fakeDb(tier: string, live: number) {
  const calls: any[] = [];
  return {
    calls,
    db: {
      tenant: { findUnique: async () => ({ tier }) },
      publicShareToken: { count: async (args: any) => { calls.push(args); return live; } },
    } as any,
  };
}
const quotas = EDITION !== "community";

describe("requireShareLinkQuota", () => {
  it("blocks the 4th live link on the free plan with a 402", async () => {
    const res = await requireShareLinkQuota(user, fakeDb("community", 3).db);
    if (!quotas) return expect(res).toBeNull();
    expect(res?.status).toBe(402);
  });

  it("allows under the cap, and counts only unexpired links in this workspace", async () => {
    const f = fakeDb("growth", 49);
    expect(await requireShareLinkQuota(user, f.db)).toBeNull();
    if (!quotas) return;
    expect(f.calls[0].where.tenantId).toBe("t1");
    expect(f.calls[0].where.OR).toEqual([{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }]);
  });

  it("never limits Business", async () => {
    expect(await requireShareLinkQuota(user, fakeDb("business", 10_000).db)).toBeNull();
  });
});
