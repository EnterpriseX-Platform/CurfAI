/**
 * Who may read the metrics. Shared by the web route and the worker's metrics listener so both answer the same way:
 * `PROM_SCRAPE_SECRET` unset = not activated (503, fail closed); otherwise the secret must arrive either as the
 * `x-prom-secret` header or as `Authorization: Bearer <secret>` (what a Prometheus ServiceMonitor/PodMonitor can send).
 * Compared in constant time. The query string is never read: a secret there would end up in access logs.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export type ScrapeVerdict = "ok" | "unconfigured" | "unauthorized";

function same(a: string, b: string): boolean {
  // Hashing first makes both sides 32 bytes, so a wrong-length guess neither throws nor leaks the length.
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export function scrapeVerdict(header: (name: string) => string | null | undefined, secret = process.env.PROM_SCRAPE_SECRET): ScrapeVerdict {
  if (!secret) return "unconfigured";
  const bearer = header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const given = header("x-prom-secret") ?? bearer ?? "";
  return given && same(given, secret) ? "ok" : "unauthorized";
}
