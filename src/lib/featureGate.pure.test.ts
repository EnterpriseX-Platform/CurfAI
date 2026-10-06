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
  it("names the connector", () => {
    expect(humanizeFeatureKey("connector.snowflake")).toBe("Snowflake connector");
  });

  it("handles nested viz.chart.* keys", () => {
    expect(humanizeFeatureKey("viz.chart.sankey")).toBe("Sankey chart");
  });

  it("keeps acronyms and product names cased correctly", () => {
    // These five all came out mangled when the label was derived from the
    // key ("Scim", "Bigquery connector", "Sso oidc builtin", "Dashboard kpi
    // ticker", "Rbac") — customers read this string in the 402 body.
    expect(humanizeFeatureKey("gov.scim")).toBe("SCIM directory sync");
    expect(humanizeFeatureKey("connector.bigquery")).toBe("BigQuery connector");
    expect(humanizeFeatureKey("gov.sso_oidc_builtin")).toBe("Google and GitHub sign-in");
    expect(humanizeFeatureKey("dashboard.kpi_ticker")).toBe("Dashboard KPI ticker");
    expect(humanizeFeatureKey("gov.rbac")).toBe("Custom roles");
  });

  it("reads as a sentence in the 402 body", () => {
    // The live template is `${label} requires the ${plan} plan.`
    expect(`${humanizeFeatureKey("gov.rbac")} requires the Growth plan.`).toBe(
      "Custom roles requires the Growth plan.",
    );
  });

  it("gives every feature key a label", () => {
    // The `satisfies Record<FeatureKey, string>` on FEATURE_LABELS makes this
    // a compile-time guarantee too; asserting it here means a key smuggled in
    // past the type (a cast, a ts-expect-error) still gets caught.
    const missing = (Object.keys(FEATURE_TIERS) as FeatureKey[]).filter(
      (k) => !humanizeFeatureKey(k) || humanizeFeatureKey(k) === k,
    );
    expect(missing).toEqual([]);
  });

  it("never gives two keys the same label", () => {
    // apps.publish and activation.publish both used to render as "Publish",
    // and apps.unlimited / activation.unlimited both as "Unlimited" — two
    // different upsells behind one indistinguishable string.
    const byLabel = new Map<string, FeatureKey[]>();
    for (const key of Object.keys(FEATURE_TIERS) as FeatureKey[]) {
      const label = humanizeFeatureKey(key);
      byLabel.set(label, [...(byLabel.get(label) ?? []), key]);
    }
    const collisions = [...byLabel.entries()].filter(([, keys]) => keys.length > 1);
    expect(collisions).toEqual([]);
  });
});
