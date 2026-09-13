/**
 * GET /api/v1/docs — self-describing endpoint catalog.
 *
 * Returned as plain JSON so customers can build clients without scraping
 * source. Stable contract: each endpoint lists path + method + auth +
 * brief description. Add new v1 endpoints here when you ship them.
 *
 * Public — no auth required to read (the schema is part of the public
 * surface). Lists only the v1 namespace.
 *
 * The public API is READ-ONLY — every endpoint listed here is a GET, or
 * a POST that computes/queries and returns a result without creating,
 * updating, or deleting any Curf entity (ask-chat, cell-run, semantic
 * search, agent Q&A). There is no create/update/delete surface exposed
 * to third parties; all authoring happens through the authenticated app.
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    version: "1.0",
    auth: {
      header: "Authorization: Bearer <api-key>",
      keyFormat: "curf_<prefix><secret>",
      mintAt: "/admin/api-keys",
      docsUrl: "/api/v1/docs",
    },
    // MCP — a different TRANSPORT over this same read-only surface (every
    // tool below wraps one of the endpoints in `endpoints`), not a second
    // API. Same auth, same key. Not REST-shaped, so it lives alongside
    // `endpoints` rather than inside it.
    mcp: {
      endpoint: "/api/mcp",
      transport: "Streamable HTTP (stateless — no session id)",
      auth: "Authorization: Bearer <api-key>, same header as the REST endpoints below",
      connect: 'claude mcp add --transport http curf <origin>/api/mcp --header "Authorization: Bearer curf_..."',
      tools: [
        "list_reports", "get_report", "get_report_data", "ask_report",
        "list_tables", "get_table_rows",
        "search_catalog", "semantic_search",
        "list_watchers", "get_watcher_runs",
        "run_agent",
      ],
      resources: ["curf://reports/{id}", "curf://tables/{name}"],
      prompts: ["brief_report"],
    },
    endpoints: [
      // ---- Reports ----------------------------------------------------
      {
        method: "GET", path: "/api/v1/reports",
        description: "List reports in your workspace.",
        params: { q: "name substring filter", limit: "1..200, default 50", cursor: "id cursor for pagination" },
        roleRequired: "viewer",
      },
      {
        method: "GET", path: "/api/v1/reports/{id}",
        description: "Fetch one report's metadata + validated definition JSON.",
        roleRequired: "viewer",
      },
      {
        method: "GET", path: "/api/v1/reports/{id}/data",
        description: "Run a report and return the dataset as { [queryId]: rows[] }.",
        params: { "p.<name>": "Report parameter values; falls back to report defaults" },
        roleRequired: "viewer",
      },
      {
        method: "POST", path: "/api/v1/reports/{id}/ask-chat",
        description: "Multi-turn conversational chat over a report's live dataset — pass a running message history, get prose + an optional structured action + suggested follow-ups. Rate limited to 30 turns/min per tenant.",
        roleRequired: "viewer",
      },
      // ---- Lake --------------------------------------------------------
      {
        method: "GET", path: "/api/v1/lake/tables",
        description: "List lake tables visible to your role (RBAC applied).",
        roleRequired: "viewer",
      },
      {
        method: "GET", path: "/api/v1/lake/tables/{name}/rows",
        description: "Fetch rows. Honours column-level PII/secret redaction.",
        params: { limit: "1..5000, default 100", offset: "0+, default 0" },
        roleRequired: "viewer",
      },
      // ---- Dashboards ----------------------------------------------------
      {
        method: "GET", path: "/api/v1/dashboards",
        description: "List dashboards visible to your role (same visibility rules as data sources: owner-only / role-allowlist / tenant-wide).",
        roleRequired: "viewer",
      },
      // ---- Watchers ------------------------------------------------------
      {
        method: "GET", path: "/api/v1/watchers",
        description: "List watchers (anomaly/threshold monitors) for the tenant. Admins and API keys see all watchers; other roles see their own.",
        roleRequired: "viewer",
      },
      {
        method: "GET", path: "/api/v1/watchers/{id}/runs",
        description: "Run history for one watcher, newest first.",
        params: { limit: "1..100, default 20" },
        roleRequired: "viewer",
      },
      // ---- Notebooks -----------------------------------------------------
      {
        method: "GET", path: "/api/v1/notebooks",
        description: "List notebooks for the tenant (metadata only, no cells).",
        roleRequired: "viewer",
      },
      {
        method: "GET", path: "/api/v1/notebooks/{id}",
        description: "Fetch a notebook with all cells, ordered.",
        roleRequired: "viewer",
      },
      {
        method: "POST", path: "/api/v1/notebooks/{id}/cells/{cellId}/run",
        description: "Execute a single cell (sql/chart/markdown/agent) synchronously and return its output.",
        roleRequired: "viewer",
      },
      // ---- Agent -----------------------------------------------------
      {
        method: "POST", path: "/api/v1/agent/run",
        description: "Drive a multi-turn agent conversation over your workspace's data. Returns the whole reply in one shot (no streaming). Read-only — mutating tools are never exposed on the public API.",
        params: { message: "string, required", priorMessages: "AgentMessage[], optional history" },
        roleRequired: "viewer",
      },
      // ---- Catalog / Search ------------------------------------------------
      {
        method: "GET", path: "/api/v1/catalog/search",
        description: "Cross-resource search across lake tables, materialized views, reports, saved views, and connections — free-text query plus faceted filters (kind, domain, curated, since).",
        params: { q: "free-text query", kind: "lake_table | mv | report | saved_view | connection", domain: "string filter", curated: "1 to restrict to curated rows", since: "ISO date filter" },
        roleRequired: "viewer",
      },
      {
        method: "POST", path: "/api/v1/search/semantic",
        description: "Tenant-scoped semantic (embedding) search across reports/blocks/prompts/watcher runs/schema columns/metrics. Requires CURF_VECTOR_DB=on (503s otherwise).",
        params: { query: "string, required", kind: "report | block | mb_prompt | watcher_run | schema_col | metric, required", limit: "1..50, default 5" },
        roleRequired: "viewer",
      },
      // ---- Workspace templates --------------------------------------------
      {
        method: "GET", path: "/api/v1/workspace-templates",
        description: "List available workspace templates (metadata only) — small static catalog, unauthenticated so the marketing site can browse it.",
        roleRequired: "none (public)",
      },
    ],
    // Per-route, not a blanket policy — most v1 reads have no throttle
    // beyond authentication today. Listed here so a caller doesn't plan
    // around a global number that was never actually enforced.
    rateLimits: {
      "POST /api/v1/agent/run": "20 per tenant per minute",
      "POST /api/v1/search/semantic": "60 per tenant per minute",
      "POST /api/v1/reports/{id}/ask-chat": "30 per tenant per minute",
      other: "no additional throttle beyond authentication",
    },
  });
}
