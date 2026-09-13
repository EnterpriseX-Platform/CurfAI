/**
 * GET /api/observability/prometheus
 *
 * Prometheus scrape endpoint for the metrics defined in src/lib/metrics.ts
 * (see docs/SLO.md, Harness 11). Deliberately NOT at /api/metrics — that
 * path is the unrelated Semantic Metric Layer CRUD API
 * (src/app/api/metrics/route.ts, see docs/SEMANTIC_METRIC_LAYER.md).
 *
 * Gated by PROM_SCRAPE_SECRET: unset means "not activated in this
 * environment" (503), not "open to the world" — this is a cluster-internal
 * endpoint with no per-tenant auth, so it must never be reachable without
 * the secret configured.
 */
import { NextRequest, NextResponse } from "next/server";
import { registry } from "@/lib/metrics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const secret = process.env.PROM_SCRAPE_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "Prometheus scraping is not configured — set PROM_SCRAPE_SECRET." },
      { status: 503 },
    );
  }
  if (req.headers.get("x-prom-secret") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await registry.metrics();
  return new NextResponse(body, {
    status: 200,
    headers: { "Content-Type": registry.contentType },
  });
}
