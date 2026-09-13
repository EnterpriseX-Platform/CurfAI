/**
 * Unit tests for billing.ts's pure tier-comparison logic — tierAtLeast(),
 * planForTier(), priceIdForTier(). These had zero direct coverage despite
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
import { tierAtLeast, planForTier, priceIdForTier, PLANS, type Tier } from "./billing";

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

describe("priceIdForTier", () => {
  it("returns null for a plan with no priceEnvVar (community, enterprise)", () => {
    expect(priceIdForTier("community")).toBeNull();
    expect(priceIdForTier("enterprise")).toBeNull();
  });

  it("returns null when the plan's price env var isn't set", () => {
    delete process.env.STRIPE_PRICE_TEAM;
    expect(priceIdForTier("growth")).toBeNull();
  });

  it("reads the price id from the plan's configured env var when set", () => {
    process.env.STRIPE_PRICE_TEAM = "price_123";
    expect(priceIdForTier("growth")).toBe("price_123");
    delete process.env.STRIPE_PRICE_TEAM;
  });
});
