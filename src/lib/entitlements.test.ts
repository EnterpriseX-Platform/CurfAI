/**
 * Entitlements: what an operator may override, how an override changes a plan, when it stops applying, and what the
 * Stripe webhook may do to a workspace that has one.
 */
import { describe, it, expect } from "vitest";
import {
  parseLimitOverrides, applyLimitOverrides, entitlementActive, tierWithEntitlement, capValue, limitValue,
  EntitlementInputSchema, LimitOverridesSchema, LIMIT_FIELDS,
} from "./entitlements";
import { planForTier, aiCreditsPerMonth } from "./plans";

const future = new Date(Date.now() + 86_400_000 * 30);
const past = new Date(Date.now() - 1000);

describe("limit overrides", () => {
  it("accepts whole numbers and 'unlimited' for the known limits, and nothing else", () => {
    expect(LimitOverridesSchema.safeParse({ reports: 200, apps: "unlimited", lakeBytes: 10 * 1024 ** 3 }).success).toBe(true);
    expect(LimitOverridesSchema.safeParse({ reports: -1 }).success).toBe(false);
    expect(LimitOverridesSchema.safeParse({ reports: 1.5 }).success).toBe(false);
    expect(LimitOverridesSchema.safeParse({ reports: "lots" }).success).toBe(false);
    expect(LimitOverridesSchema.safeParse({ tier: "enterprise" }).success).toBe(false); // an unknown key is refused, not ignored
  });

  it("every field the console shows is a limit the schema knows", () => {
    for (const f of LIMIT_FIELDS) expect(LimitOverridesSchema.safeParse({ [f.key]: 1 }).success).toBe(true);
  });

  it("anything unreadable stored in the database counts as no override instead of failing a quota check", () => {
    expect(parseLimitOverrides(null)).toEqual({});
    expect(parseLimitOverrides("")).toEqual({});
    expect(parseLimitOverrides("not json")).toEqual({});
    expect(parseLimitOverrides('{"reports":"many"}')).toEqual({});
    expect(parseLimitOverrides('{"reports":10}')).toEqual({ reports: 10 });
  });

  it("limitValue and capValue translate 'unlimited' the way each caller spells it", () => {
    expect(limitValue("unlimited")).toBe(Infinity);
    expect(limitValue(7)).toBe(7);
    expect(capValue(undefined, 100)).toBe(100); // not overridden: the plan's own cap
    expect(capValue("unlimited", 100)).toBeNull(); // lake/document caps say "none" with null
    expect(capValue(5, null)).toBe(5);
  });
});

describe("applyLimitOverrides", () => {
  const growth = planForTier("growth");

  it("replaces only the limits that were overridden and leaves the catalog plan untouched", () => {
    const out = applyLimitOverrides(growth, { reports: 500, apps: "unlimited" });
    expect(out.features.reports).toBe(500);
    expect(out.features.apps).toBe(Infinity);
    expect(out.features.dashboards).toBe(growth.features.dashboards);
    expect(growth.features.reports).toBe(50); // the catalog entry is not mutated
    expect(growth.features.apps).toBe(3);
    expect(out.tier).toBe("growth");
  });

  it("an AI credit override is the workspace's whole allowance, whatever its seats", () => {
    const out = applyLimitOverrides(growth, { aiCredits: 10_000 });
    expect(aiCreditsPerMonth(out, { editors: 3, viewers: 40 })).toBe(10_000);
    expect(aiCreditsPerMonth(growth, { editors: 3, viewers: 40 })).toBe(3 * 500 + 40 * 50);
    expect(aiCreditsPerMonth(applyLimitOverrides(growth, { aiCredits: "unlimited" }), { editors: 1, viewers: 0 })).toBe(Infinity);
  });

  it("with no overrides the plan is the same plan", () => {
    expect(applyLimitOverrides(growth, {}).features).toEqual(growth.features);
  });
});

describe("entitlementActive", () => {
  it("is active until its end date, and with no end date it never ends", () => {
    expect(entitlementActive({ validUntil: future })).toBe(true);
    expect(entitlementActive({ validUntil: null })).toBe(true);
    expect(entitlementActive({ validUntil: past })).toBe(false);
    expect(entitlementActive(null)).toBe(false);
    expect(entitlementActive(undefined)).toBe(false);
  });
});

describe("tierWithEntitlement — what a subscription event may do to a workspace an operator has set up", () => {
  const contract = { source: "contract", tier: "enterprise", validUntil: future };
  const trial = { source: "trial", tier: "business", validUntil: future };

  it("with no entitlement, or one that has ended, Stripe decides", () => {
    expect(tierWithEntitlement("growth", null)).toEqual({ tier: "growth", dropEntitlement: false });
    expect(tierWithEntitlement("community", { ...contract, validUntil: past })).toEqual({ tier: "community", dropEntitlement: false });
  });

  it("a contract is never overwritten — not by a paid plan, not by a cancelled subscription", () => {
    expect(tierWithEntitlement("community", contract)).toEqual({ tier: "enterprise", dropEntitlement: false });
    expect(tierWithEntitlement("growth", contract)).toEqual({ tier: "enterprise", dropEntitlement: false });
    expect(tierWithEntitlement("community", { ...contract, validUntil: null })).toEqual({ tier: "enterprise", dropEntitlement: false });
  });

  it("a trial gives way to a real paid subscription, and is dropped", () => {
    expect(tierWithEntitlement("growth", trial)).toEqual({ tier: "growth", dropEntitlement: true });
  });

  it("a trial survives a subscription that is not paid (the tier stays the trial's)", () => {
    expect(tierWithEntitlement("community", trial)).toEqual({ tier: "business", dropEntitlement: false });
  });

  it("an entitlement naming a tier that doesn't exist is ignored rather than trusted", () => {
    expect(tierWithEntitlement("growth", { source: "contract", tier: "platinum", validUntil: null })).toEqual({ tier: "growth", dropEntitlement: false });
  });
});

describe("EntitlementInputSchema — what an operator may submit", () => {
  const base = { source: "contract" as const, tier: "enterprise" as const, reason: "Annual contract signed, PO 4500123" };

  it("needs a reason that says something", () => {
    expect(EntitlementInputSchema.safeParse({ ...base, reason: "ok" }).success).toBe(false);
    expect(EntitlementInputSchema.safeParse({ ...base, reason: "" }).success).toBe(false);
    expect(EntitlementInputSchema.safeParse(base).success).toBe(true);
  });

  it("an end date must be in the future", () => {
    expect(EntitlementInputSchema.safeParse({ ...base, validUntil: past.toISOString() }).success).toBe(false);
    expect(EntitlementInputSchema.safeParse({ ...base, validUntil: future.toISOString() }).success).toBe(true);
  });

  it("a trial always ends; a contract may not", () => {
    expect(EntitlementInputSchema.safeParse({ ...base, source: "trial" }).success).toBe(false);
    expect(EntitlementInputSchema.safeParse({ ...base, source: "trial", validUntil: future.toISOString() }).success).toBe(true);
    expect(EntitlementInputSchema.safeParse({ ...base, validUntil: null }).success).toBe(true);
  });

  it("refuses an unknown tier, an unknown limit and a source that isn't one of ours", () => {
    expect(EntitlementInputSchema.safeParse({ ...base, tier: "platinum" }).success).toBe(false);
    expect(EntitlementInputSchema.safeParse({ ...base, limits: { everything: "unlimited" } }).success).toBe(false);
    expect(EntitlementInputSchema.safeParse({ ...base, source: "manual" }).success).toBe(false);
  });
});
