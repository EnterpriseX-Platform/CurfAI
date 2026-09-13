/**
 * Next.js instrumentation hook — Curf (Harness 11).
 *
 * Next.js calls `register()` exactly once at boot per runtime (Node /
 * Edge). We use it to bootstrap OpenTelemetry on the Node runtime; the
 * Edge runtime does not get traced today (Vercel's OTel for Edge has a
 * different shape and we don't ship middleware that justifies it yet).
 *
 * The import is deferred so the OTel module isn't loaded at all when
 * NEXT_RUNTIME is "edge" — keeps the Edge bundle lean.
 *
 * Activation: set OTEL_EXPORTER_OTLP_ENDPOINT in the runtime env. With
 * no env var, this is a no-op and adds no measurable boot time.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initOtel } = await import("./lib/otel");
    initOtel();
  }
}
