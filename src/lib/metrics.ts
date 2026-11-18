/**
 * Prometheus metrics — Curf (Harness 11; what each one means and what pages on it: docs/OBSERVABILITY.md).
 *
 * One registry per process, scraped at /api/observability/prometheus (web) and on CURF_METRICS_PORT (the job worker); see
 * src/app/api/observability/prometheus/route.ts. (Not /api/metrics — that path is the unrelated Semantic Metric Layer API.)
 *
 * Rules every metric here follows:
 *   - No label holds a tenant, a person or anything a person typed. A workspace id as a label is unbounded cardinality and,
 *     on a shared scrape endpoint, tenant data; per-workspace numbers live in the database (LlmTokenUsage, AuditEvent), not here.
 *   - Every label value comes from a short fixed set in code (an outcome, a queue name, a status class) or is bounded by a guard
 *     (the HTTP route label, see lib/observability/http.ts).
 *   - Seconds, not milliseconds, for anything new (report_run_ms is the one older exception, kept so its SLO query still reads).
 *
 * What changes between processes: state that only a scrape of the web pod can read (database connections, queue depth, SCIM
 * retry rows) is added at scrape time by lib/observability/state.ts; everything below is incremented where the work happens, so
 * the process that runs a cron tick or a job is the one that reports it.
 * (Those state gauges are defined in that module, not here, so a worker never exports a `curf_db_up 0` it never measured.) `role` (web | worker) is a default label on every series.
 *
 * `prom-client` is declared in package.json; if it cannot be loaded the metrics become no-ops rather than taking the server
 * down. The registry lives on globalThis so the two copies of this module that Next compiles (instrumentation, route handlers)
 * and a dev-server reload share one set of metrics instead of registering the same name twice.
 */

// Project lints with next/core-web-vitals which doesn't load the @typescript-eslint plugin, so `unknown` stands in for the
// prom-client types and the lazy require below stays ungated.
export type MetricLike = {
  inc?: (labels?: Record<string, string>, value?: number) => void;
  observe?: (labels: Record<string, string>, value?: number) => void;
  set?: (labels: Record<string, string>, value?: number) => void;
};

export type RegistryLike = {
  contentType: string;
  metrics: () => Promise<string>;
  setDefaultLabels?: (labels: Record<string, string>) => void;
  getSingleMetric?: (name: string) => unknown;
};

const NOOP: MetricLike = { inc: () => {}, observe: () => {}, set: () => {} };
const NOOP_REGISTRY: RegistryLike = {
  contentType: "text/plain; version=0.0.4; charset=utf-8",
  metrics: async () => "# prom-client not installed — install to populate\n",
};

const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

type Kit = {
  registry: RegistryLike;
  counter: (name: string, help: string, labelNames: string[]) => MetricLike;
  histogram: (name: string, help: string, labelNames: string[], buckets: number[]) => MetricLike;
  gauge: (name: string, help: string, labelNames: string[]) => MetricLike;
};

function loadKit(): Kit {
  try {
    const prom = require("prom-client");
    const g = globalThis as { __curfPromRegistry?: any };
    const registry = (g.__curfPromRegistry ??= new prom.Registry());
    // Same name asked for twice (a second copy of this module, a dev reload) returns the metric already there.
    const once = <T,>(name: string, make: () => T): T => (registry.getSingleMetric(name) as T | undefined) ?? make();
    return {
      registry,
      counter: (name, help, labelNames) => once(name, () => new prom.Counter({ name, help, labelNames, registers: [registry] })) as MetricLike,
      histogram: (name, help, labelNames, buckets) => once(name, () => new prom.Histogram({ name, help, labelNames, buckets, registers: [registry] })) as MetricLike,
      gauge: (name, help, labelNames) => once(name, () => new prom.Gauge({ name, help, labelNames, registers: [registry] })) as MetricLike,
    };
  } catch {
    return {
      registry: NOOP_REGISTRY,
      counter: () => NOOP,
      histogram: () => NOOP,
      gauge: () => NOOP,
    };
  }
}

const kit = loadKit();
export const registry: RegistryLike = kit.registry;

/** For lib/observability/state.ts, whose gauges exist only in the web pod (the worker has no database probe to report). */
export const defineGauge = kit.gauge;

// Process metrics (CPU, memory, event loop lag, GC, open handles) under prom-client's standard names, so the usual
// dashboards read them. The event loop matters here: SQLite lake reads run on it (see k8s/deployment.yaml's probe note).
try {
  const g = globalThis as { __curfDefaultMetrics?: boolean };
  if (!g.__curfDefaultMetrics && registry !== NOOP_REGISTRY) {
    g.__curfDefaultMetrics = true;
    require("prom-client").collectDefaultMetrics({ register: registry });
    registry.setDefaultLabels?.({ role: "web" });
  }
} catch { /* metrics are optional */ }

/** The job worker calls this once at start so its series are told apart from the web pod's. */
export function setMetricsRole(role: "web" | "worker"): void {
  registry.setDefaultLabels?.({ role });
}

// ── HTTP (lib/observability/http.ts) ────────────────────────────────────────
export const httpRequests = kit.counter("curf_http_requests_total", "HTTP requests by method, route template and status class", ["method", "route", "code"]);
export const httpRequestSeconds = kit.histogram("curf_http_request_duration_seconds", "HTTP request duration by method and route template", ["method", "route"], HTTP_BUCKETS);

// ── Reports ────────────────────────────────────────────────────────────────
// Buckets sized for typical viewer SSR (50 ms-15 s); 3000 is the viewer SLO's own line (docs/SLO.md), so "runs over 3 s" is
// one bucket subtracted from the count rather than a guess between two buckets.
export const reportRunMs = kit.histogram("curf_report_run_ms", "Report run latency in milliseconds", [], [50, 100, 250, 500, 1000, 2500, 3000, 5000, 10000, 15000]);
export const reportQueueDepth = kit.gauge("curf_report_queue_depth", "Pending export jobs by kind", ["kind"]);

// ── LLM (lib/llm/index.ts) ─────────────────────────────────────────────────
export const llmTokens = kit.counter("curf_llm_tokens_total", "LLM tokens consumed, by call kind", ["kind"]);
export const llmCalls = kit.counter("curf_llm_calls_total", "LLM calls by provider, outcome and whose key paid", ["provider", "status", "key_source"]);
export const llmCallSeconds = kit.histogram("curf_llm_call_duration_seconds", "LLM call duration by provider", ["provider"], [0.5, 1, 2, 5, 10, 20, 40, 80, 160, 300]);
export const llmCostUsd = kit.counter("curf_llm_cost_usd_total", "Metered LLM cost in US dollars, by provider and whose key paid (env = Curf's own)", ["provider", "key_source"]);

// ── Cron tick and jobs (lib/cron/observe.ts, lib/jobs/worker.ts) ───────────
export const cronRuns = kit.counter("curf_cron_runs_total", "Cron runs by kind (schedule_loop, schedule_scan, platform_ticks) and outcome", ["run", "status"]);
export const cronRunSeconds = kit.histogram("curf_cron_run_duration_seconds", "Cron run duration by kind", ["run"], [1, 5, 15, 30, 60, 120, 300]);
export const cronLastSuccess = kit.gauge("curf_cron_last_success_timestamp_seconds", "Unix time the last cron run of this kind finished without throwing", ["run"]);
export const cronTickErrors = kit.counter("curf_cron_tick_errors_total", "Sweeps inside a platform tick that answered with an error (each is caught, so the run itself still succeeds)", ["tick"]);
export const cronFired = kit.counter("curf_cron_fired_total", "Items a tick or schedule fired, by kind and status", ["kind", "status"]);
export const jobRuns = kit.counter("curf_job_runs_total", "Queue jobs finished by queue, job name and outcome (ok, failed, delayed)", ["queue", "job", "status"]);
export const jobSeconds = kit.histogram("curf_job_duration_seconds", "Queue job duration", ["queue", "job"], [0.1, 0.5, 1, 5, 15, 60, 300, 900]);

// ── Identity (src/ee/identity) ─────────────────────────────────────────────
export const keycloakAdminCalls = kit.counter("curf_keycloak_admin_calls_total", "Calls to the Keycloak admin API by step (token, api) and outcome (ok, http_4xx, http_5xx, unreachable)", ["op", "outcome"]);
export const scimRetryOutcomes = kit.counter("curf_scim_retry_outcomes_total", "SCIM Keycloak retries by outcome: done, retry (will try again), gave_up", ["outcome"]);

// A counter only exists once something has incremented it, and Prometheus' increase() cannot see a series' first step (nothing
// to subtract it from). The counters the alerts take an increase() of start at 0 for every value they can take, so the first
// failure after a restart is still seen.
for (const op of ["token", "api"]) for (const outcome of ["ok", "http_4xx", "http_5xx", "unreachable"]) keycloakAdminCalls.inc?.({ op, outcome }, 0);
for (const outcome of ["done", "retry", "gave_up"]) scimRetryOutcomes.inc?.({ outcome }, 0);
for (const run of ["schedule_loop", "schedule_scan", "platform_ticks"]) for (const status of ["ok", "error"]) cronRuns.inc?.({ run, status }, 0);
