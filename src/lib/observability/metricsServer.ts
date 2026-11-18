/**
 * The job worker has no web server, so it serves its own metrics: GET /metrics on CURF_METRICS_PORT (default 9464), gated by the
 * same PROM_SCRAPE_SECRET as the web route (lib/observability/scrapeAuth.ts). Without that secret it does not listen at all.
 * It answers /metrics only; every other path is a 404.
 */
import http from "node:http";
import { registry } from "@/lib/metrics";
import { scrapeVerdict } from "@/lib/observability/scrapeAuth";
import { log } from "@/lib/log";

export function startMetricsServer(port = Number(process.env.CURF_METRICS_PORT) || 9464): http.Server | null {
  if (!process.env.PROM_SCRAPE_SECRET) {
    log.info("metrics listener off: PROM_SCRAPE_SECRET is not set");
    return null;
  }
  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method !== "GET" || path !== "/metrics") { res.writeHead(404).end(); return; }
    const verdict = scrapeVerdict((n) => {
      const v = req.headers[n];
      return Array.isArray(v) ? v[0] : v;
    });
    if (verdict !== "ok") { res.writeHead(verdict === "unconfigured" ? 503 : 401).end(); return; }
    try {
      const body = await registry.metrics();
      res.writeHead(200, { "Content-Type": registry.contentType, "Cache-Control": "no-store" }).end(body);
    } catch (e) {
      log.error("metrics scrape failed", { err: e });
      res.writeHead(500).end();
    }
  });
  server.on("error", (e) => log.error("metrics listener error", { err: e }));
  server.listen(port, () => log.info("metrics listener up", { port }));
  return server;
}
