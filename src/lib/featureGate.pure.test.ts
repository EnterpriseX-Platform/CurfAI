/**
 * Unit tests for featureGate.ts's pure logic — featureAvailable() and
 * humanizeFeatureKey(). Zero direct coverage previously, despite this
 * being the single source of truth for "what tier does feature X need"
 * across every premium surface in the app (connectors, viz, AI, gov/SCIM,
 * lake, activations, ...).
 *
 * Scope note: featureGate() itself (the async, DB-backed 402 responder)
 * isn't covered here — see billing.pure.test.ts's scope note for why.
 */
import { describe, it, expect } from "vitest";
import { featureAvailable, humanizeFeatureKey, FEATURE_TIERS, type FeatureKey } from "./featureGate";

describe("featureAvailable", () => {
  it("a tenant at the required tier has access", () => {
    expect(featureAvailable("growth", "connector.sftp")).toBe(true);
  });

  it("a tenant below the required tier does not", () => {
    expect(featureAvailable("community", "connector.sftp")).toBe(false);
  });

  it("a tenant above the required tier has access", () => {
    expect(featureAvailable("business", "connector.sftp")).toBe(true);
  });

  it("null/unknown tier fails closed", () => {
    expect(featureAvailable(null, "connector.sftp")).toBe(false);
  });

  it("Community-edition decisions (2026-09-13): Postgres, MySQL and email schedules have no gate key at all", () => {
    // ...while the warehouse connectors and chat delivery stay paid.
    expect("connector.postgres" in FEATURE_TIERS).toBe(false);
    expect("delivery.schedules" in FEATURE_TIERS).toBe(false);
    expect(featureAvailable("community", "connector.snowflake")).toBe(false);
    expect(featureAvailable("community", "intelligence.brief_delivery")).toBe(false);
  });

  it("external viewers is Business, like the other app access gates", () => {
    expect(featureAvailable("growth", "apps.external_viewers")).toBe(false);
    expect(featureAvailable("business", "apps.external_viewers")).toBe(true);
    expect(FEATURE_TIERS["apps.external_viewers"]).toBe(FEATURE_TIERS["apps.password_gate"]);
  });

  it("every FEATURE_TIERS entry resolves to a real Tier value", () => {
    const validTiers = new Set(["community", "growth", "business", "enterprise"]);
    for (const [key, tier] of Object.entries(FEATURE_TIERS)) {
      expect(validTiers.has(tier), `${key} maps to invalid tier "${tier}"`).toBe(true);
    }
  });
});

describe("humanizeFeatureKey", () => {
  it("strips the connector prefix and appends 'connector'", () => {
    expect(humanizeFeatureKey("connector.snowflake")).toBe("Snowflake connector");
  });

  it("handles nested viz.chart.* keys", () => {
    expect(humanizeFeatureKey("viz.chart.sankey")).toBe("Sankey chart");
  });

  it("capitalizes AI context", () => {
    expect(humanizeFeatureKey("ai.story_mode")).toBe("AI story mode");
  });

  it("capitalizes the gov context", () => {
    expect(humanizeFeatureKey("gov.scim" as FeatureKey)).toBe("Scim");
  });

  it("underscores become spaces in the feature name", () => {
    expect(humanizeFeatureKey("dashboard.kpi_ticker")).toBe("Dashboard kpi ticker");
  });
});
