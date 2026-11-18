/**
 * Next.js instrumentation hook — Curf (Harness 11).
 *
 * Next.js calls `register()` exactly once at boot per runtime (Node /
 * Edge). We use it to bootstrap OpenTelemetry on the Node runtime; the
 * Edge runtime does not get traced today (Vercel's OTel for Edge has a
 * different shape and we don't ship middleware that justifies it yet).
 * Also registers the streaming-ingest buffer's flush-on-shutdown hook
 * here (E2_JOBS_SCOPING_PLAN.md Phase B) — same lifecycle, same reason
 * it only makes sense on the Node runtime. That hook lives behind `ee`
 * rather than a direct import: streaming push is Business+ only and
 * excluded from the Community export wholesale, and this file (unlike
 * most `ee` call sites in lib/lake/) ships in Community — see
 * ee.lake.registerStreamIngestShutdownFlush's own doc comment.
 *
 * The OTel import is deferred so the module doesn't load at all when
 * NEXT_RUNTIME is "edge" — keeps the Edge bundle lean.
 *
 * Activation: OTel needs OTEL_EXPORTER_OTLP_ENDPOINT in the runtime env
 * and no-ops without it. The shutdown-flush hook is unconditional — it
 * only matters if a buffer is non-empty at signal time either way, and
 * is simply absent in Community (ee.lake is undefined there).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Request ids, request metrics and the per-request log context for every request (lib/observability/http.ts).
    const { installHttpObserver } = await import("./lib/observability/http");
    installHttpObserver();
    const { initOtel } = await import("./lib/otel");
    initOtel();
    const { ee } = await import("@/ee");
    await ee.lake?.registerStreamIngestShutdownFlush();
  }
}

/**
 * Next calls this for every error thrown while rendering a page or running a route handler (not for a handler that returns a
 * 500 itself — the HTTP observer counts and logs those). It is the line that says *what* threw: the error with a short stack, the
 * route template (`/api/reports/[id]`, never the URL), and the request id the log context already holds.
 */
export async function onRequestError(
  err: unknown,
  _request: { path: string; method: string },
  context: { routerKind: string; routePath: string; routeType: string },
): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { log } = await import("./lib/log");
  log.error("unhandled error in request", { err, routePath: context.routePath, routeType: context.routeType, routerKind: context.routerKind });
}
