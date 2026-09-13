/**
 * Prometheus metrics — Curf (Harness 11).
 *
 * Three metric families form the SLO substrate (see docs/SLO.md):
 *   - llm token usage (Counter, labelled by tenant + kind) — wired into
 *     callLLM()'s usage-recording path (src/lib/llm/index.ts).
 *   - report run latency (Histogram, labelled by tenant) — wired into
 *     runReportWithProof(), the single execution core every report-running
 *     route/page ultimately calls (src/lib/reporting/runner.ts).
 *   - report queue depth (Gauge, labelled by kind: pdf|xlsx|docx|csv) —
 *     DEFINED BUT NOT WIRED. There is no real export-queue concept in the
 *     codebase yet (exports run synchronously, not through a job queue);
 *     wire this once one exists instead of setting it from a fake source.
 *
 * Scrape the registry at /api/observability/prometheus — see
 * src/app/api/observability/prometheus/route.ts. (Not /api/metrics — that
 * path is the unrelated Semantic Metric Layer CRUD API.)
 *
 * The `prom-client` package is loaded lazily so the absence of the dep
 * doesn't crash the server. Each exported metric is a noop-safe shim
 * until the real client is installed; once `prom-client` is available
 * the shim is replaced by the real Counter/Histogram/Gauge on first
 * import. This means existing call sites can `import { llmTokens } from
 * "@/lib/metrics"` today without waiting on the dep being installed.
 */
// Project lints with next/core-web-vitals which doesn't load the
// @typescript-eslint plugin, so we use `unknown` instead of `any` and
// keep the lazy require below ungated.

type MetricLike = {
  inc?: (labels?: Record<string, string>, value?: number) => void;
  observe?: (labels: Record<string, string>, value?: number) => void;
  set?: (labels: Record<string, string>, value?: number) => void;
};

type RegistryLike = {
  contentType: string;
  metrics: () => Promise<string>;
};

// Sentinel registry that returns an empty Prometheus exposition. Used
// when prom-client isn't installed so the /api/metrics endpoint still
// responds with a valid (empty) scrape body.
const NOOP_REGISTRY: RegistryLike = {
  contentType: "text/plain; version=0.0.4; charset=utf-8",
  metrics: async () => "# prom-client not installed — install to populate\n",
};

const NOOP: MetricLike = {
  inc: () => {},
  observe: () => {},
  set: () => {},
};

let _registry: RegistryLike = NOOP_REGISTRY;
let _llmTokens: MetricLike = NOOP;
let _reportRunMs: MetricLike = NOOP;
let _reportQueueDepth: MetricLike = NOOP;

try {
  const promClient = require("prom-client");
  const { Counter, Histogram, Gauge, register } = promClient;

  _llmTokens = new Counter({
    name: "curf_llm_tokens_total",
    help: "LLM tokens consumed",
    labelNames: ["tenant", "kind"],
  });
  _reportRunMs = new Histogram({
    name: "curf_report_run_ms",
    help: "Report run latency in milliseconds",
    labelNames: ["tenant"],
    // Buckets sized for typical viewer SSR (50ms-15s). Anything past
    // 15s is bucketed into +Inf and pages the SLO.
    buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000, 15000],
  });
  _reportQueueDepth = new Gauge({
    name: "curf_report_queue_depth",
    help: "Pending export jobs by kind",
    labelNames: ["kind"],
  });
  _registry = register;
} catch {
  // prom-client not installed — keep the noop shims. Safe to import
  // from anywhere; no runtime cost beyond the empty-shim calls.
}

export const llmTokens = _llmTokens;
export const reportRunMs = _reportRunMs;
export const reportQueueDepth = _reportQueueDepth;
export const registry = _registry;
