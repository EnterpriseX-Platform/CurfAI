import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/observability/state", () => ({ refreshScrapeState: async () => {} }));

import { NextRequest } from "next/server";
import { GET } from "./route";
import { cronRuns, httpRequests } from "@/lib/metrics";

const call = (headers: Record<string, string> = {}) =>
  GET(new NextRequest("http://x/api/observability/prometheus", { headers }));

afterEach(() => { delete process.env.PROM_SCRAPE_SECRET; });

describe("GET /api/observability/prometheus", () => {
  it("is off (503) until a secret is configured, whatever the caller sends", async () => {
    expect((await call()).status).toBe(503);
    expect((await call({ "x-prom-secret": "anything" })).status).toBe(503);
  });

  it("refuses a missing or wrong secret", async () => {
    process.env.PROM_SCRAPE_SECRET = "s3cret";
    expect((await call()).status).toBe(401);
    expect((await call({ "x-prom-secret": "wrong" })).status).toBe(401);
  });

  it("serves the registry for the header or a bearer token", async () => {
    process.env.PROM_SCRAPE_SECRET = "s3cret";
    httpRequests.inc?.({ method: "GET", route: "/api/test", code: "2xx" });
    cronRuns.inc?.({ run: "platform_ticks", status: "ok" });
    for (const headers of [{ "x-prom-secret": "s3cret" }, { authorization: "Bearer s3cret" }] as Record<string, string>[]) {
      const res = await call(headers);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const text = await res.text();
      expect(text).toContain('curf_http_requests_total{method="GET",route="/api/test",code="2xx",role="web"}');
      expect(text).toContain("curf_cron_runs_total");
      expect(text).toContain("nodejs_eventloop_lag_seconds");
    }
  });

  it("carries no tenant or person label on any series", async () => {
    process.env.PROM_SCRAPE_SECRET = "s3cret";
    const text = await (await call({ "x-prom-secret": "s3cret" })).text();
    expect(text).not.toMatch(/\b(tenant|tenantId|userId|email|user)=/i);
  });
});
