/**
 * Connector marketplace registry.
 *
 * Two concepts:
 *
 *   1. KINDS — the storage-level connector types the runner already supports
 *      (sqlite, rest, postgres, mysql, snowflake, bigquery, excel). Each has
 *      metadata (label, blurb, icon, capabilities, tier gate) so the picker
 *      can render a polished gallery.
 *
 *   2. RECIPES — pre-templated REST connections for popular SaaS APIs
 *      (Stripe, HubSpot, Mixpanel, etc.). A recipe ALWAYS materialises as
 *      `kind="rest"` in the database; the recipe just pre-fills baseUrl,
 *      auth header pattern, and 1–2 starter endpoint suggestions. This
 *      keeps the runner code simple — no per-vendor adapters — while the
 *      UX feels like a marketplace.
 *
 * Why no full OAuth: provider OAuth needs per-deployment client IDs +
 * secrets + a callback URL allowlisted with each vendor. A bring-your-own-
 * API-key flow ships today and works for 80% of pitch use cases.
 */
import type { FeatureKey } from "@/lib/featureGate";

export type ConnectorCapability =
  | "sql"           // arbitrary SQL queries (databases)
  | "rest"          // HTTP-templated requests
  | "schemaProbe"   // can introspect tables/fields ahead of report design
  | "incremental"   // supports incremental sync via cursor params
  | "writeBack";    // round-trip writes (future — none today)

export type ConnectorKindMeta = {
  /** Storage-level kind. Matches DataSource.kind. */
  kind: string;
  label: string;
  /** One-sentence blurb shown on the picker card. */
  blurb: string;
  /** Lucide icon name (resolved client-side). */
  iconName: "Database" | "Globe" | "Cloud" | "FileSpreadsheet" | "Layers" | "Zap" | "CreditCard" | "Users" | "BarChart3";
  capabilities: ConnectorCapability[];
  /** Which tier is required (if any). Free if undefined. */
  feature?: FeatureKey;
  /** Optional vendor docs link rendered in the picker. */
  docsUrl?: string;
};

/** The 7 storage kinds the runner supports today. */
export const CONNECTOR_KINDS: ConnectorKindMeta[] = [
  {
    kind: "sqlite",
    label: "SQLite",
    blurb: "Local in-tenant database. Great for the sample data + quick prototypes.",
    iconName: "Database",
    capabilities: ["sql", "schemaProbe"],
  },
  {
    kind: "excel",
    label: "Excel / CSV upload",
    blurb: "Drop a .xlsx or .csv. Each sheet becomes a queryable table.",
    iconName: "FileSpreadsheet",
    capabilities: ["sql", "schemaProbe"],
  },
  {
    kind: "postgres",
    label: "Postgres",
    blurb: "Production-grade Postgres. Read-only role + SSL recommended.",
    iconName: "Database",
    capabilities: ["sql", "schemaProbe", "incremental"],
  },
  {
    kind: "mysql",
    label: "MySQL",
    blurb: "MySQL or MariaDB. Same workflow as Postgres.",
    iconName: "Database",
    capabilities: ["sql", "schemaProbe", "incremental"],
  },
  {
    kind: "snowflake",
    label: "Snowflake",
    blurb: "Cloud data warehouse. Account locator + warehouse + role.",
    iconName: "Cloud",
    capabilities: ["sql", "schemaProbe", "incremental"],
    feature: "connector.snowflake",
  },
  {
    kind: "bigquery",
    label: "BigQuery",
    blurb: "Google's serverless warehouse. Service account JSON.",
    iconName: "Cloud",
    capabilities: ["sql", "schemaProbe", "incremental"],
    feature: "connector.bigquery",
  },
  {
    kind: "rest",
    label: "REST / HTTP-JSON",
    blurb: "Generic JSON API. Templated URLs, optional bearer/basic auth.",
    iconName: "Globe",
    capabilities: ["rest", "schemaProbe"],
  },
];

/**
 * Recipe for a popular SaaS API. Materialises as a `rest` DataSource with
 * the auth header + base URL pre-filled. Each comes with 1–2 example
 * endpoint suggestions a user can paste into the query editor on day one.
 */
export type ConnectorRecipe = {
  /** Stable id used in URL slugs / analytics. */
  id: string;
  label: string;
  /** Where the user gets the API key — surfaced in the form. */
  credentialHowTo: string;
  /** Base URL prefilled into the connection. */
  baseUrl: string;
  /** Auth strategy. Drives the form. */
  auth: { kind: "bearer" } | { kind: "header"; headerName: string } | { kind: "basic" };
  /** Lucide icon. */
  iconName: ConnectorKindMeta["iconName"];
  /** One-line marketing blurb. */
  blurb: string;
  /** Pre-canned endpoints the user can pick to scaffold their first query. */
  exampleEndpoints: Array<{ path: string; description: string; jsonPath?: string }>;
  docsUrl: string;
};

export const CONNECTOR_RECIPES: ConnectorRecipe[] = [
  {
    id: "stripe",
    label: "Stripe",
    blurb: "Charges, customers, subscriptions, invoices.",
    iconName: "CreditCard",
    baseUrl: "https://api.stripe.com/v1",
    auth: { kind: "bearer" },
    credentialHowTo: "Stripe → Developers → API keys → Restricted key (read-only).",
    exampleEndpoints: [
      { path: "/charges?limit=100", description: "Recent charges (last 100)", jsonPath: "$.data" },
      { path: "/customers?limit=100", description: "Recent customers", jsonPath: "$.data" },
      { path: "/subscriptions?status=active&limit=100", description: "Active subscriptions", jsonPath: "$.data" },
    ],
    docsUrl: "https://stripe.com/docs/api",
  },
  {
    id: "hubspot",
    label: "HubSpot",
    blurb: "Contacts, deals, companies, the whole CRM graph.",
    iconName: "Users",
    baseUrl: "https://api.hubapi.com",
    auth: { kind: "bearer" },
    credentialHowTo: "HubSpot → Settings → Integrations → Private Apps → Create.",
    exampleEndpoints: [
      { path: "/crm/v3/objects/contacts?limit=100", description: "Contacts", jsonPath: "$.results" },
      { path: "/crm/v3/objects/deals?limit=100", description: "Deals", jsonPath: "$.results" },
      { path: "/crm/v3/objects/companies?limit=100", description: "Companies", jsonPath: "$.results" },
    ],
    docsUrl: "https://developers.hubspot.com/docs/api/overview",
  },
  {
    id: "mixpanel",
    label: "Mixpanel",
    blurb: "Event analytics — funnels, segmentation, retention.",
    iconName: "BarChart3",
    baseUrl: "https://mixpanel.com/api/2.0",
    auth: { kind: "basic" },
    credentialHowTo: "Mixpanel → Settings → Service Accounts → Create. Username = service account, password = secret.",
    exampleEndpoints: [
      { path: "/events?event=signup&from_date=2024-01-01&to_date=2024-12-31", description: "Signup events" },
      { path: "/segmentation?event=purchase&unit=day", description: "Daily purchase segmentation" },
    ],
    docsUrl: "https://developer.mixpanel.com/reference/overview",
  },
  {
    id: "posthog",
    label: "PostHog",
    blurb: "Open-source product analytics — events, sessions, feature flags.",
    iconName: "BarChart3",
    baseUrl: "https://app.posthog.com/api",
    auth: { kind: "bearer" },
    credentialHowTo: "PostHog → Project settings → Personal API keys → Create (Read scope).",
    exampleEndpoints: [
      { path: "/projects/PROJECT_ID/events?event=$pageview", description: "Pageview events", jsonPath: "$.results" },
      { path: "/projects/PROJECT_ID/persons", description: "Identified users", jsonPath: "$.results" },
    ],
    docsUrl: "https://posthog.com/docs/api",
  },
  {
    id: "github",
    label: "GitHub",
    blurb: "Repos, PRs, issues, contributors. Per-org or per-repo.",
    iconName: "Layers",
    baseUrl: "https://api.github.com",
    auth: { kind: "bearer" },
    credentialHowTo: "GitHub → Settings → Developer settings → Personal access tokens (classic).",
    exampleEndpoints: [
      { path: "/repos/OWNER/REPO/pulls?state=all&per_page=100", description: "PRs in a repo" },
      { path: "/repos/OWNER/REPO/issues?state=all&per_page=100", description: "Issues in a repo" },
      { path: "/orgs/ORG/members?per_page=100", description: "Org members" },
    ],
    docsUrl: "https://docs.github.com/en/rest",
  },
  {
    id: "linear",
    label: "Linear",
    blurb: "Issues, projects, cycles. GraphQL — paste the body in the request.",
    iconName: "Zap",
    baseUrl: "https://api.linear.app",
    auth: { kind: "header", headerName: "Authorization" },
    credentialHowTo: "Linear → Settings → API → Personal API keys.",
    exampleEndpoints: [
      { path: "/graphql", description: "GraphQL endpoint (POST query body)", jsonPath: "$.data.issues.nodes" },
    ],
    docsUrl: "https://developers.linear.app/docs/graphql/working-with-the-graphql-api",
  },
  {
    id: "shopify",
    label: "Shopify",
    blurb: "Orders, products, customers from a Shopify storefront.",
    iconName: "CreditCard",
    baseUrl: "https://YOUR-SHOP.myshopify.com/admin/api/2024-01",
    auth: { kind: "header", headerName: "X-Shopify-Access-Token" },
    credentialHowTo: "Shopify Admin → Apps → Develop apps → Custom app → Admin API access token.",
    exampleEndpoints: [
      { path: "/orders.json?limit=100", description: "Recent orders", jsonPath: "$.orders" },
      { path: "/products.json?limit=100", description: "Products", jsonPath: "$.products" },
    ],
    docsUrl: "https://shopify.dev/docs/api/admin-rest",
  },
];

/**
 * Lookup helper used by the New Connection wizard. Pairs the recipe
 * metadata with a starter REST connection payload the API can persist
 * directly — caller fills in just the API key.
 */
export function buildRestConnectionFromRecipe(recipe: ConnectorRecipe, apiKey: string, opts?: { username?: string }): {
  baseUrl: string;
  headers: Record<string, string>;
  auth: { username?: string; password?: string };
} {
  const headers: Record<string, string> = {};
  let auth: { username?: string; password?: string } = {};
  if (recipe.auth.kind === "bearer") {
    headers["Authorization"] = `Bearer ${apiKey}`;
  } else if (recipe.auth.kind === "header") {
    headers[recipe.auth.headerName] = apiKey;
  } else if (recipe.auth.kind === "basic") {
    auth = { username: opts?.username ?? "", password: apiKey };
  }
  return { baseUrl: recipe.baseUrl, headers, auth };
}

export function findRecipe(id: string): ConnectorRecipe | undefined {
  return CONNECTOR_RECIPES.find((r) => r.id === id);
}

export function findKind(kind: string): ConnectorKindMeta | undefined {
  return CONNECTOR_KINDS.find((k) => k.kind === kind);
}
