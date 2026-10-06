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
    const { initOtel } = await import("./lib/otel");
    initOtel();
    const { ee } = await import("@/ee");
    await ee.lake?.registerStreamIngestShutdownFlush();
  }
}
