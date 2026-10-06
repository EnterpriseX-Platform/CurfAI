/**
 * Central feature → tier matrix.
 *
 * The single source of truth for "what tier do I need to use feature X."
 * Adding a new gated feature = one line in FEATURE_TIERS below, its label
 * in FEATURE_LABELS, and one featureGate() call (lib/featureGate.ts)
 * wherever the feature is invoked.
 *
 * This module is pure so client components can import it — UpgradeLock and
 * the admin/operate managers read featureAvailable() against the session's
 * tier. Keep server imports out: lib/featureGate.ts, which re-exports all
 * of this beside the async featureGate(), pulls in lib/billing and through
 * it lib/db (db.clientBundle.test.ts).
 */
import { type Tier, tierAtLeast } from "@/lib/plans";

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
  "connector.snowflake":  "business",
  "connector.bigquery":   "business",
  "connector.sftp":       "growth",
  "connector.attach":     "growth",     // Cross-source ATTACH (Tier 1 join)
  "connector.hash_join":  "business", // Cross-source hash join (Tier 2 join)
  "connector.engine":     "enterprise", // The Java engine (engines/java), an alternative query engine run on the customer's side

  // ---- Visualization polish (Tier 1 of the viz roadmap) ----
  "viz.threshold_lines":     "growth",
  "viz.conditional_table":   "growth",
  "viz.theme_presets":       "growth",

  // ---- New chart types (Tier 2 of the viz roadmap) ----
  "viz.chart.bullet":    "growth",
  "viz.kpi_plan":        "growth", // a KPI held against its plan — "4.1% behind plan" on the card, the Brief and the Executive view
  "viz.chart.sankey":    "growth",
  "viz.chart.waterfall": "growth",
  "viz.chart.gauge":     "growth",
  "viz.chart.boxplot":   "growth",
  "viz.chart.network":   "growth",
  "viz.chart.chord":     "growth",
  "viz.chart.parallel":  "growth",
  "viz.chart.radial":    "growth",
  "viz.chart.scatter3d": "growth",

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
  "apps.what_if":       "business",    // What-if tab: driver sliders over the app's verified KPIs, saved scenarios

  // ---- Dashboards ----
  "dashboard.tiled":         "growth",
  "dashboard.kpi_ticker":    "business",
  "dashboard.anomaly_focus": "business",
  "dashboard.kiosk_token":   "business",

  // ---- Intelligence Layer ----
  "intelligence.watchers":         "growth",
  "intelligence.watchers_predictive": "growth", // mode:"predictive" — projects the watched series, same tier as ai.forecast_linear which it reuses
  "intelligence.decision_log":     "business", // the Decisions ledger and quarterly review: a decision against a metric, scored at review time (moved from Growth, CEO 2026-09-27)
  "assign.core":                   "growth", // executive journey P2 — hand work to a person from a number, tracked until the number moves
  "exec.strategist":               "business", // the Executive view's Strategist: a big question planned, researched on your data, and turned into next steps (CEO 2026-09-27)
  "exec.advisor":                  "business", // the Executive view's Advisor: behind-plan, wrong-way, stalled and worked suggestions on Home (CEO 2026-09-27)
  "exec.board_pack":               "business", // executive journey P6 — an app's board pack PDF, emailed; meeting mode
  "assign.assistants":             "business", // executive journey P5 — executive assistants prepare approvals and draft assignments
  "line.own_oa":                   "enterprise", // executive journey P4b — the workspace's own LINE Official Account (their brand, their bill, not metered)
  "line.shared":                   "business", // executive journey P4 — assignments on LINE through Curf's shared Official Account, metered (plans.ts lineMessages)
  "intelligence.brief":            "growth",
  "intelligence.brief_delivery":   "business", // Slack/Teams/Discord/email outbound
  "intelligence.signed_webhooks":  "business",
  "doc.corpus":                    "growth", // Knowledge Centre — PDF/DOCX/text upload + RAG Q&A (D2)
  "doc.vision_assets":             "enterprise", // Photos/voice notes with a captioning plug-in seam (D4)

  // ---- Delivery ----
  // Scheduled email delivery is Community (same decision) — Jasper users
  // expect a scheduled PDF in their inbox. Slack / Teams / Discord and signed
  // webhooks stay Business via intelligence.brief_delivery / signed_webhooks.
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
 * Customer-facing name for every gated feature, used in the 402 error body
 * and the UpgradeLock UI. These land inside "{feature} requires the {plan}
 * plan" and "{feature} is a {plan} feature", so each one has to read as a
 * noun phrase a customer recognises.
 *
 * Hand-written on purpose. This used to derive the label from the key
 * itself, which produced copy nobody could act on — "gov.rbac" came out as
 * "Rbac requires the Growth plan.", "gov.sso_oidc_builtin" as "Sso oidc
 * builtin", and both "apps.publish" and "activation.publish" as the bare
 * word "Publish", so the two upsells were indistinguishable.
 *
 * `satisfies Record<FeatureKey, string>` is the guard: add a key to
 * FEATURE_TIERS without a label here and the build fails, rather than
 * silently shipping another auto-mangled string to a customer.
 */
const FEATURE_LABELS = {
  // ---- Connectors ----
  "connector.snowflake":  "Snowflake connector",
  "connector.bigquery":   "BigQuery connector",
  "connector.sftp":       "SFTP connector",
  "connector.attach":     "Cross-source join (ATTACH)",
  "connector.hash_join":  "Cross-source join (hash join)",
  "connector.engine":     "Java engine connector",

  // ---- Visualization ----
  "viz.threshold_lines":   "Threshold lines on charts",
  "viz.conditional_table": "Conditional table formatting",
  "viz.theme_presets":     "Report theme presets",
  "viz.chart.bullet":      "Bullet chart",
  "viz.kpi_plan":          "KPI against plan",
  "viz.chart.sankey":      "Sankey chart",
  "viz.chart.waterfall":   "Waterfall chart",
  "viz.chart.gauge":       "Gauge chart",
  "viz.chart.boxplot":     "Box plot",
  "viz.chart.network":     "Network chart",
  "viz.chart.chord":       "Chord chart",
  "viz.chart.parallel":    "Parallel axes chart",
  "viz.chart.radial":      "Radial (24-hour) chart",
  "viz.chart.scatter3d":   "3D scatter",

  // ---- AI ----
  "ai.chart_caption":       "AI chart captions",
  "ai.story_mode":          "AI story mode",
  "ai.forecast_llm":        "AI-written forecast narrative",
  "ai.forecast_linear":     "Trend forecasting",
  "ai.forecast_accuracy":   "Forecast accuracy tracking",
  "ai.compare_mode":        "AI compare mode",
  "ai.talks_back":          "Ask Curf",
  "ai.suggest_charts":      "AI chart suggestions",
  "ai.why_everywhere":      "The Why? explainer",
  "ai.cross_workspace_ask": "Asking across workspaces",

  // ---- Analytic Apps ----
  "apps.publish":          "Publishing an analytic app",
  "apps.multi_view":       "Multi-view apps",
  "apps.password_gate":    "Password-protected apps",
  "apps.custom_brand":     "App custom branding",
  "apps.unlimited":        "Unlimited analytic apps",
  "apps.instant_views":    "Instant app views",
  "apps.external_viewers": "External app viewers",
  "apps.what_if":          "What-if analysis in apps",

  // ---- Dashboards ----
  "dashboard.tiled":         "Tiled dashboards",
  "dashboard.kpi_ticker":    "Dashboard KPI ticker",
  "dashboard.anomaly_focus": "Dashboard anomaly focus",
  "dashboard.kiosk_token":   "Dashboard kiosk mode",

  // ---- Intelligence Layer ----
  "intelligence.watchers":            "Watchers",
  "intelligence.watchers_predictive": "Predictive watchers",
  "intelligence.decision_log":        "Decisions ledger and quarterly review",
  "assign.core":                      "Assignments",
  "assign.assistants":                "Executive assistants",
  "exec.strategist":                 "Strategist",
  "exec.advisor":                    "Advisor",
  "exec.board_pack":                  "Board pack and meeting mode",
  "line.shared":                      "Assignments on LINE",
  "line.own_oa":                      "Your own LINE Official Account",
  "intelligence.brief":               "The Brief",
  "intelligence.brief_delivery":      "Brief delivery to Slack, Teams and Discord",
  "intelligence.signed_webhooks":     "Signed webhooks",
  "doc.corpus":                       "Knowledge Centre",
  "doc.vision_assets":                "Photo and voice attachments",

  // ---- Delivery ----
  "delivery.embed_iframe": "Embedding a report in another site",

  // ---- Governance / Enterprise ----
  "gov.rbac":                 "Custom roles",
  "gov.connection_acl":       "Connection visibility rules",
  "gov.sso_oidc_builtin":     "Google and GitHub sign-in",
  "gov.sso_oidc_custom":      "Single sign-on with your own provider",
  "gov.scim":                 "SCIM directory sync",
  "gov.api_keys":             "API keys",
  "gov.tenant_anthropic_key": "Bringing your own AI key",
  "gov.audit_log_extended":   "Extended audit log retention",
  "gov.custom_branding":      "Custom branding",

  // ---- Lake / infra / ops ----
  "lake.engine.duckdb":       "The DuckDB lake engine",
  "lake.parquet_export":      "Parquet export",
  "lake.stream_ingest":       "Streaming ingest",
  "infra.dedicated_instance": "A dedicated instance",
  "ops.custom_retention":     "Custom retention windows",

  // ---- Activations (reverse ETL) ----
  "activation.publish":    "Activations (reverse ETL)",
  "activation.salesforce": "Salesforce activations",
  "activation.hubspot":    "HubSpot activations",
  "activation.unlimited":  "Unlimited activations",

  // ---- Organization ----
  "org.platform_admin": "Platform Admin oversight",

  // ---- Catalog ----
  "catalog.curate": "Curated catalog domains",
} as const satisfies Record<FeatureKey, string>;

/**
 * Friendly name for the 402 error body and the UpgradeLock UI.
 *
 *   "gov.rbac"             → "Custom roles"
 *   "viz.chart.sankey"     → "Sankey chart"
 *   "dashboard.kpi_ticker" → "Dashboard KPI ticker"
 *
 * The `?? key` is unreachable for a well-typed call; it only catches a key
 * read back from an older audit row or API client, where showing the raw
 * key beats showing "undefined".
 */
export function humanizeFeatureKey(key: FeatureKey): string {
  return FEATURE_LABELS[key] ?? key;
}
