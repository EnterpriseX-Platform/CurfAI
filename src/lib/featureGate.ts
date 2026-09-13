/**
 * Central feature → tier matrix.
 *
 * The single source of truth for "what tier do I need to use feature X."
 * Adding a new gated feature = one line in FEATURE_TIERS below + one
 * featureGate() call wherever the feature is invoked.
 *
 * This sits one layer above `requireTier()` from lib/billing.ts:
 *   - lib/billing.ts answers "does this user's tenant have at least Growth?"
 *   - lib/featureGate.ts answers "does this user's tenant have access to
 *     the Postgres connector / kiosk tokens / AI chart captions / …?"
 *
 * Splitting the matrix out keeps lib/billing.ts focused on Stripe + plan
 * primitives, and gives every gated surface a single import to call.
 */
import type { NextResponse } from "next/server";
import type { CurfSessionUser } from "@/lib/auth";
import { type Tier, requireTier, tierAtLeast, planForTier, UPGRADE_URL } from "@/lib/billing";

/**
 * Every gated feature in Curf, mapped to the minimum tier required.
 * Community-tier features (everything not listed) don't need a gate.
 *
 * Naming convention: `<area>.<feature>` so the keys group logically when
 * sorted. Keep the keys human-readable — they appear in 402 error bodies
 * and audit logs.
 */
export const FEATURE_TIERS = {
  // ---- Connectors ----
  // Postgres and MySQL are Community (decision 2026-09-13, Community-edition
  // split): an open-source Jasper replacement has to talk to a real database.
  // Kept as keys so the connector registry and UpgradeLock still have a
  // feature to name; a "community" gate always passes.
  "connector.postgres":   "community",
  "connector.mysql":      "community",
  "connector.snowflake":  "business",
  "connector.bigquery":   "business",
  "connector.sftp":       "growth",
  "connector.attach":     "growth",     // Cross-source ATTACH (Tier 1 join)
  "connector.hash_join":  "business", // Cross-source hash join (Tier 2 join)

  // ---- Visualization polish (Tier 1 of the viz roadmap) ----
  "viz.threshold_lines":     "growth",
  "viz.conditional_table":   "growth",
  "viz.theme_presets":       "growth",

  // ---- New chart types (Tier 2 of the viz roadmap) ----
  "viz.chart.bullet":    "growth",
  "viz.chart.sankey":    "growth",
  "viz.chart.waterfall": "growth",
  "viz.chart.gauge":     "growth",

  // ---- AI / storytelling features (Tier 4 of the viz roadmap) ----
  "ai.chart_caption":  "business",
  "ai.story_mode":     "business",
  "ai.forecast_llm":   "business",
  "ai.forecast_linear":"growth",
  // Forecast Accuracy / Trust Layer — records what a forecast overlay
  // predicted and grades it once the real value arrives. A step up from
  // just SHOWING a forecast (free for every viewer via ForecastControl),
  // so it sits at Business alongside the other trust/differentiation
  // features (ai.chart_caption, ai.story_mode).
  "ai.forecast_accuracy": "business",
  "ai.compare_mode":   "growth",
  "ai.talks_back":     "growth",
  "ai.generate_unlimited": "business", // Community=10/mo, Growth=100/mo, Business=∞
  "ai.suggest_charts": "growth",         // Claude looks at your data, proposes the next viz
  "ai.why_everywhere": "growth",         // Click any number → narrative explanation of what's driving it
  "ai.cross_workspace_ask": "business",  // Ask without picking a report first — fans out to several, costs more per question

  // ---- Analytic Apps (Slice — distribution surface) ----
  "apps.publish":       "growth",        // base ability to publish a report as an app (single-view)
  "apps.multi_view":    "business",    // more than one view (tabs) on a single app
  "apps.password_gate": "business",    // password-protect an app
  "apps.custom_brand":  "business",    // hide "Made with Curf" footer + apply tenant brand chrome
  "apps.unlimited":     "business",    // Community=0 apps, Growth=3 apps, Business=∞ — quota-style
  "apps.instant_views": "business",    // free-text "+" tab and "turn this into a view" on Ask/Copilot answers
  "apps.external_viewers": "business", // invite people outside the workspace to a portal login that only sees granted apps

  // ---- Dashboards ----
  "dashboard.tiled":         "growth",
  "dashboard.kpi_ticker":    "business",
  "dashboard.anomaly_focus": "business",
  "dashboard.kiosk_token":   "business",

  // ---- Intelligence Layer ----
  "intelligence.watchers":         "growth",
  "intelligence.watchers_predictive": "growth", // mode:"predictive" — projects the watched series, same tier as ai.forecast_linear which it reuses
  "intelligence.decision_log":     "growth", // log a decision against a metric, get told at review time whether it moved
  "intelligence.brief":            "growth",
  "intelligence.brief_delivery":   "business", // Slack/Teams/Discord/email outbound
  "intelligence.signed_webhooks":  "business",
  "doc.corpus":                    "growth", // Knowledge Centre — PDF/DOCX/text upload + RAG Q&A (D2)
  "doc.vision_assets":             "enterprise", // Photos/voice notes with a captioning plug-in seam (D4)

  // ---- Delivery ----
  // Scheduled email delivery is Community (same decision) — Jasper users
  // expect a scheduled PDF in their inbox. Slack / Teams / Discord and signed
  // webhooks stay Business via intelligence.brief_delivery / signed_webhooks.
  "delivery.schedules":     "community",
  "delivery.email_digest":  "community",
  "delivery.embed_iframe":  "growth",

  // ---- Governance / Enterprise ----
  "gov.rbac":                      "growth",
  "gov.connection_acl":            "growth",     // "Just me" + Roles visibility
  "gov.sso_oidc_builtin":          "growth",     // Google / GitHub
  "gov.sso_oidc_custom":           "business",
  "gov.scim":                      "business",   // SCIM 2.0 directory sync (Okta/Azure AD/Google) — same tier as custom OIDC
  "gov.api_keys":                  "growth",
  "gov.tenant_anthropic_key":      "business",
  "gov.audit_log_extended":        "business", // retention beyond 30 days
  "gov.custom_branding":           "business",
  // Lake storage engine. SQLite is universal; DuckDB is Growth+ because
  // the columnar perf benefit only matters at table sizes Community tenants
  // don't reach, and the larger native binary footprint isn't worth
  // bundling for the under-100MB lake bracket.
  "lake.engine.duckdb":            "growth",
  // Parquet export to off-site destinations. Business+ — pairs with
  // the existing off-site destinations (also Business). Powers the
  // "Snowflake / BigQuery / Athena read directly" story.
  "lake.parquet_export":           "business",
  // High-throughput streaming ingest endpoint. Business+ because the
  // in-memory per-tenant buffer is a different cost shape; customers
  // who need 500-row batches are already on the data-volume tier.
  "lake.stream_ingest":            "business",
  // Dedicated-instance — single-tenant infra with guaranteed RAM
  // headroom + custom retention. Mostly a pricing dimension; specific
  // entitlements gated below.
  "infra.dedicated_instance":      "enterprise",
  // Custom snapshot retention windows, custom backup frequency, custom
  // off-site replication SLA. Gated together at enterprise tier.
  "ops.custom_retention":          "enterprise",

  // ---- Round 7: Reverse ETL / activation layer ----
  // Activations are the operational write-back surface — push lake rows
  // into Salesforce, HubSpot, Slack, generic webhooks. Growth can ship
  // generic webhook + Slack activations; first-party CRM connectors are
  // Business+ since they involve OAuth flows and per-event volume.
  "activation.publish":            "growth",       // base ability to create activations
  "activation.salesforce":         "business",
  "activation.hubspot":            "business",
  "activation.unlimited":          "business",   // Community=0, Growth=3, Business=∞
  // ---- Organization (2026-08 role restructure) ----
  // Platform Admin oversight (seeing every workspace in your org without
  // joining each one, granting the role to others) — the OrgMembership
  // grant itself is created for every signup regardless of tier (harmless
  // until a feature actually reads it), so Community stays capped at
  // ordinary per-workspace Admin purely by this gate never passing.
  "org.platform_admin":            "growth",

  // ---- Round 7: Catalog / discoverability ----
  // The catalog itself is free — search across your own tables. Curated
  // domains (admin-promoted view, pinned tables, custom homepage) are
  // a Growth feature so the larger your tenant the more value you get.
  "catalog.curate":                "growth",
} as const satisfies Record<string, Tier>;

export type FeatureKey = keyof typeof FEATURE_TIERS;

/**
 * Synchronous check against a known tier. Use this in client components
 * (where the tier is in the session) and in render-time UI gating. For API
 * routes, use the async featureGate() below — it reads the tenant tier
 * fresh from the DB so a webhook upgrade lands immediately.
 */
export function featureAvailable(currentTier: string | null | undefined, key: FeatureKey): boolean {
  const required = FEATURE_TIERS[key];
  return tierAtLeast(currentTier, required);
}

/**
 * Friendly name for the 402 error body and the UpgradeLock UI. Strips the
 * area prefix and humanizes the rest.
 *
 *   "connector.postgres"        → "Postgres connector"
 *   "viz.chart.sankey"          → "Sankey chart"
 *   "dashboard.kpi_ticker"      → "Dashboard KPI ticker"
 */
export function humanizeFeatureKey(key: FeatureKey): string {
  const parts = key.split(".");
  // Last segment is the feature name; everything before is context.
  const main = parts[parts.length - 1].replace(/_/g, " ");
  const context = parts.slice(0, -1).map((p) => p === "ai" ? "AI" : p).join(" ");
  // Capitalize first letter, leave rest as-is.
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  if (context === "viz chart") return `${cap(main)} chart`;
  if (context === "viz") return `${cap(main)} visualization`;
  if (context === "connector") return `${cap(main)} connector`;
  if (context === "dashboard") return `Dashboard ${main}`;
  if (context === "AI") return `AI ${main}`;
  if (context === "intelligence") return `${cap(main)} (Intelligence Layer)`;
  if (context === "delivery") return `${cap(main)} delivery`;
  if (context === "gov") return cap(main);
  return cap(main);
}

/**
 * Server-side gate. Returns null when the tenant has access; otherwise a
 * 402 NextResponse the API handler should return immediately.
 *
 *   const block = await featureGate(user, "connector.postgres");
 *   if (block) return block;
 *
 * The 402 body adds `feature` + a human label so the client can render a
 * targeted upgrade prompt instead of a generic "upgrade required" toast.
 */
export async function featureGate(
  user: CurfSessionUser,
  key: FeatureKey,
): Promise<NextResponse | null> {
  const required = FEATURE_TIERS[key];
  const block = await requireTier(user, required);
  if (!block) return null;
  // requireTier already produced a 402 with currentTier/requiredTier/upgradeUrl;
  // we re-emit with feature context. We don't await/parse the original body —
  // we already know the values that went into it from FEATURE_TIERS.
  const NextResponse = (await import("next/server")).NextResponse;
  return NextResponse.json(
    {
      error: `${humanizeFeatureKey(key)} requires the ${planForTier(required).name} plan.`,
      feature: key,
      featureLabel: humanizeFeatureKey(key),
      requiredTier: required,
      upgradeUrl: UPGRADE_URL,
    },
    { status: 402 },
  );
}
