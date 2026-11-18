/**
 * GET /api/observability/prometheus
 *
 * Prometheus scrape endpoint for the metrics defined in src/lib/metrics.ts (docs/OBSERVABILITY.md, docs/SLO.md). Deliberately
 * NOT at /api/metrics — that path is the unrelated Semantic Metric Layer CRUD API (src/app/api/metrics/route.ts).
 *
 * Gated by PROM_SCRAPE_SECRET: unset means "not activated in this environment" (503), not "open to the world" — this is a
 * cluster-internal endpoint with no per-tenant auth, so it must never be reachable without the secret configured. The secret
 * comes as `x-prom-secret` or `Authorization: Bearer` (lib/observability/scrapeAuth.ts). No series carries a workspace or a
 * person (see the rules at the top of lib/metrics.ts), so a leaked secret exposes operating numbers, not customer data.
 */
import { NextRequest, NextResponse } from "next/server";
import { registry } from "@/lib/metrics";
import { scrapeVerdict } from "@/lib/observability/scrapeAuth";
import { refreshScrapeState } from "@/lib/observability/state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const verdict = scrapeVerdict((n) => req.headers.get(n));
  if (verdict === "unconfigured") {
    return NextResponse.json(
      { error: "Prometheus scraping is not configured — set PROM_SCRAPE_SECRET." },
      { status: 503 },
    );
  }
  if (verdict !== "ok") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await refreshScrapeState();
  const body = await registry.metrics();
  return new NextResponse(body, {
    status: 200,
    headers: { "Content-Type": registry.contentType, "Cache-Control": "no-store" },
  });
}
