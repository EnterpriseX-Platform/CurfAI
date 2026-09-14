/**
 * Unit tests for billing.ts's pure tier-comparison logic — tierAtLeast(),
 * planForTier(), priceIdsForTier(). These had zero direct coverage despite
 * gating every paywall check in the app (requireTier/requireReportQuota/
 * requireWatcherQuota/featureGate all reduce to tierAtLeast() underneath).
 *
 * Scope note: the DB-backed helpers (loadTenantTier, requireTier,
 * requireReportQuota, requireWatcherQuota, requireDashboardQuota,
 * requireGenerateQuota) aren't covered here — they need a live/mocked
 * Prisma client, which this fast unit-test file intentionally avoids (see
 * vitest.config.ts's two-tier philosophy). tests/audit/tier-completeness.test.ts
 * separately guards their static prerequisite (every Tier has a PLANS entry).
 */
import { describe, it, expect } from "vitest";
import { tierAtLeast, planForTier, priceIdsForTier, tierForPriceId, billableSeats, monthlyPriceUsd, aiCreditsPerMonth, trialEligible, TRIAL_DAYS, PLANS, type Tier } from "./billing";

describe("tierAtLeast", () => {
  it("a tier is at least itself", () => {
    expect(tierAtLeast("growth", "growth")).toBe(true);
  });

  it("a higher tier passes a lower minimum", () => {
    expect(tierAtLeast("business", "growth")).toBe(true);
    expect(tierAtLeast("enterprise", "community")).toBe(true);
  });

  it("a lower tier fails a higher minimum", () => {
    expect(tierAtLeast("community", "growth")).toBe(false);
    expect(tierAtLeast("growth", "enterprise")).toBe(false);
  });

  it("null/undefined/unknown current tier is treated as community (fails closed, not open)", () => {
    expect(tierAtLeast(null, "growth")).toBe(false);
    expect(tierAtLeast(undefined, "growth")).toBe(false);
    expect(tierAtLeast("not-a-real-tier", "growth")).toBe(false);
    expect(tierAtLeast(null, "community")).toBe(true);
  });
});

describe("planForTier", () => {
  it("resolves every known tier to a plan with that exact tier", () => {
    for (const tier of ["community", "growth", "business", "enterprise"] as Tier[]) {
      expect(planForTier(tier).tier).toBe(tier);
    }
  });

  it("falls back to Community for null/unknown, not undefined/crash", () => {
    expect(planForTier(null).tier).toBe("community");
    expect(planForTier(undefined).tier).toBe("community");
    expect(planForTier("bogus-tier").tier).toBe("community");
  });

  it("every plan in PLANS is reachable via its own tier slug", () => {
    for (const plan of PLANS) {
      expect(planForTier(plan.tier)).toBe(plan);
    }
  });
});

describe("priceIdsForTier", () => {
  const ENV = ["STRIPE_PRICE_GROWTH_EDITOR", "STRIPE_PRICE_GROWTH_VIEWER", "STRIPE_PRICE_BUSINESS_EDITOR", "STRIPE_PRICE_BUSINESS_VIEWER"];
  const clear = () => { for (const k of ENV) delete process.env[k]; };

  it("returns null for a plan not sold per seat (community, enterprise)", () => {
    expect(priceIdsForTier("community")).toBeNull();
    expect(priceIdsForTier("enterprise")).toBeNull();
  });

  it("returns null unless BOTH seat price ids are set", () => {
    clear();
    expect(priceIdsForTier("growth")).toBeNull();
    process.env.STRIPE_PRICE_GROWTH_EDITOR = "price_ge";
    expect(priceIdsForTier("growth")).toBeNull();
    process.env.STRIPE_PRICE_GROWTH_VIEWER = "price_gv";
    expect(priceIdsForTier("growth")).toEqual({ editor: "price_ge", viewer: "price_gv" });
    clear();
  });

  it("maps either seat price id back to its tier", () => {
    process.env.STRIPE_PRICE_BUSINESS_EDITOR = "price_be";
    process.env.STRIPE_PRICE_BUSINESS_VIEWER = "price_bv";
    expect(tierForPriceId("price_be")).toBe("business");
    expect(tierForPriceId("price_bv")).toBe("business");
    expect(tierForPriceId("price_nope")).toBeNull();
    clear();
  });
});

describe("seat pricing", () => {
  const growth = planForTier("growth");
  const business = planForTier("business");

  it("Growth: first ten viewers are free, editors from one", () => {
    expect(billableSeats(growth, { editors: 3, viewers: 8 })).toEqual({ editors: 3, viewers: 0 });
    expect(billableSeats(growth, { editors: 3, viewers: 25 })).toEqual({ editors: 3, viewers: 15 });
    expect(monthlyPriceUsd(growth, { editors: 3, viewers: 25 })).toBe(3 * 49 + 15 * 9);
  });

  it("Business: five-editor floor, every viewer billed", () => {
    expect(billableSeats(business, { editors: 2, viewers: 4 })).toEqual({ editors: 5, viewers: 4 });
    expect(monthlyPriceUsd(business, { editors: 2, viewers: 4 })).toBe(5 * 99 + 4 * 15);
  });

  it("plans without seats price at zero", () => {
    expect(monthlyPriceUsd(planForTier("community"), { editors: 9, viewers: 9 })).toBe(0);
  });
});

describe("AI credits", () => {
  it("pools per workspace from a base plus per-seat amounts", () => {
    expect(aiCreditsPerMonth(planForTier("community"), { editors: 1, viewers: 0 })).toBe(100);
    expect(aiCreditsPerMonth(planForTier("growth"), { editors: 3, viewers: 20 })).toBe(3 * 500 + 20 * 50);
    expect(aiCreditsPerMonth(planForTier("business"), { editors: 5, viewers: 40 })).toBe(5 * 2000 + 40 * 100);
    expect(aiCreditsPerMonth(planForTier("enterprise"), { editors: 1, viewers: 1 })).toBe(Infinity);
  });
});

describe("free trial", () => {
  it("is 14 days — the number curf.ai and Terms §3 quote", () => {
    expect(TRIAL_DAYS).toBe(14);
  });

  it("a workspace that has never subscribed qualifies", () => {
    expect(trialEligible({ stripeSubscriptionId: null, stripeStatus: null })).toBe(true);
  });

  it("one trial per workspace: any past or present subscription disqualifies", () => {
    expect(trialEligible({ stripeSubscriptionId: "sub_1", stripeStatus: "active" })).toBe(false);
    expect(trialEligible({ stripeSubscriptionId: "sub_1", stripeStatus: "canceled" })).toBe(false);
    // A tenant whose subscription row was cleared but whose status was not —
    // the status alone is enough to say "you have been here before".
    expect(trialEligible({ stripeSubscriptionId: null, stripeStatus: "canceled" })).toBe(false);
  });
});
