/**
 * AI-credit metering (lib/billing.ts) against a hand-rolled db double —
 * the same `Db` shape the helpers accept from withTenantContext().
 */
import { describe, expect, it } from "vitest";
import { aiCreditStatus, requireAiCredits, MICRO_USD_PER_CREDIT } from "./billing";
import { EDITION } from "./ee/edition";

function fakeDb(opts: { tier: string; roles: Record<string, number>; spentMicro: number | null }) {
  return {
    tenant: { findUnique: async () => ({ tier: opts.tier }) },
    membership: {
      groupBy: async () => Object.entries(opts.roles).map(([role, n]) => ({ role, _count: { _all: n } })),
    },
    llmTokenUsage: {
      aggregate: async () => ({ _sum: { microCostUsd: opts.spentMicro } }),
    },
  } as any;
}

describe("aiCreditStatus", () => {
  it("pools the plan allowance across seats and rounds spend up to whole credits", async () => {
    const db = fakeDb({ tier: "growth", roles: { admin: 1, developer: 2, viewer: 20 }, spentMicro: 12 * MICRO_USD_PER_CREDIT + 1 });
    const s = await aiCreditStatus("t1", db);
    expect(s.allowance).toBe(3 * 500 + 20 * 50);
    expect(s.used).toBe(13);
    expect(s.remaining).toBe(s.allowance - 13);
    expect(s.resetsAt.endsWith("-01T00:00:00.000Z")).toBe(true);
  });

  it("treats no usage rows as zero spend", async () => {
    const s = await aiCreditStatus("t1", fakeDb({ tier: "community", roles: { admin: 1 }, spentMicro: null }));
    expect(s.used).toBe(0);
    expect(s.allowance).toBe(100);
  });
});

describe("requireAiCredits", () => {
  it("allows while under the allowance", async () => {
    const db = fakeDb({ tier: "community", roles: { admin: 1 }, spentMicro: 99 * MICRO_USD_PER_CREDIT });
    expect(await requireAiCredits("t1", db)).toBeNull();
  });

  it("returns a 402 with the upgrade path once the allowance is spent (Cloud); never meters the Community edition", async () => {
    const db = fakeDb({ tier: "community", roles: { admin: 1 }, spentMicro: 100 * MICRO_USD_PER_CREDIT });
    const res = await requireAiCredits("t1", db);
    if (EDITION === "community") { expect(res).toBeNull(); return; }
    expect(res?.status).toBe(402);
    const body = await res!.json();
    expect(body.code).toBe("ai_credits_exhausted");
    expect(body.requiredTier).toBe("growth");
    expect(body.credits.remaining).toBe(0);
  });

  it("never meters an unmetered plan", async () => {
    const db = fakeDb({ tier: "enterprise", roles: { admin: 1 }, spentMicro: 1e12 });
    expect(await requireAiCredits("t1", db)).toBeNull();
  });
});
