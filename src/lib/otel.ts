/**
 * OpenTelemetry boot — Curf (Harness 11 in tests/HARNESS_ROADMAP.md).
 *
 * Initialises an OTLP HTTP trace exporter when OTEL_EXPORTER_OTLP_ENDPOINT
 * is set, then leaves the SDK auto-instrumenting Next.js / Node HTTP /
 * Prisma. Idempotent — calling `initOtel()` twice is a no-op.
 *
 * Skipped entirely when the env var is unset so the dev experience and
 * any unconfigured deploy stays free of background work + log noise.
 *
 * Activation: set OTEL_EXPORTER_OTLP_ENDPOINT (and optionally
 * OTEL_EXPORTER_OTLP_HEADERS for vendor auth) in the runtime environment.
 * The SDK ships with sensible defaults; no other code change required.
 */
// Lazy `require()` is used below because OpenTelemetry packages may not
// be installed; a static import would fail at module-load time.

let started = false;

export function initOtel(): void {
  if (started) return;
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;

  // Lazy-required — neither package is installed by default and we only
  // want to pay the import cost when the deploy actually wants tracing.
  // The harness.yml + Dockerfile pin the dependency; until that lands,
  // this branch silently no-ops.
  try {
    const { NodeSDK } = require("@opentelemetry/sdk-node");
    const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");

    const sdk = new NodeSDK({
      serviceName: "curf",
      traceExporter: new OTLPTraceExporter({
        url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      }),
    });
    sdk.start();
    started = true;

    // Best-effort flush on shutdown — keeps the last few spans from
    // being lost when the process exits cleanly (e.g. SIGTERM during a
    // deploy roll).
    const shutdown = async () => {
      try { await sdk.shutdown(); } catch { /* ignore */ }
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (e) {
    // OpenTelemetry packages aren't installed in this build — log once
    // and move on. We don't want to crash the server because a runtime
    // dep is missing for an optional feature.
    console.warn(
      "[otel] OTEL_EXPORTER_OTLP_ENDPOINT is set but @opentelemetry/sdk-node " +
      "is not installed; tracing disabled. Run `npm i @opentelemetry/sdk-node " +
      "@opentelemetry/exporter-trace-otlp-http` to activate.",
      (e as Error)?.message ?? e,
    );
  }
}
