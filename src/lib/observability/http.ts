/**
 * Request id, request log context and request metrics for every HTTP request the Node server handles, in one place: a hook on
 * the http server's 'request' event, installed from instrumentation.ts. Hooking the server rather than wrapping routes means
 * the ~1,200 route handlers and every page get it with no change, and the request id is bound (AsyncLocalStorage, lib/log.ts)
 * before any of their code runs.
 *
 *   - `x-request-id`: a caller's own id is kept when it is short and made of safe characters (so a support ticket can quote the
 *     id the ingress or a client already uses); anything else is replaced with a new UUID. It is set on the response of every
 *     request, and is on every log line written while the request runs.
 *   - curf_http_requests_total / curf_http_request_duration_seconds, by method, route template and status class.
 *   - one log line for a 5xx, an aborted request or a slow one (>10 s). Healthy requests are counted, not logged: the ingress
 *     already has the access log, and a line per request here would be the loudest thing in the store. The line carries the route
 *     template and never the query string or the raw path, which can hold a share token.
 *
 * The route label is bounded in two ways: segments that look like ids collapse to `:id`, and once 200 distinct labels exist new
 * ones are counted as `/other`, so a scanner walking random URLs cannot grow the metric.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { httpRequests, httpRequestSeconds } from "@/lib/metrics";
import { log, withLogContext } from "@/lib/log";

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;
const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|c[a-z0-9]{20,}|[0-9a-f]{16,}|[A-Za-z0-9_-]{22,})$/i;
const MAX_ROUTES = 200;
const SLOW_MS = 10_000;

export function requestIdFrom(incoming: string | string[] | undefined): string {
  const v = Array.isArray(incoming) ? incoming[0] : incoming;
  return v && SAFE_ID.test(v) ? v : randomUUID();
}

/** The template a path belongs to: `/api/reports/cabc…/runs` -> `/api/reports/:id/runs`. Static assets share one label. */
export function routeTemplate(pathname: string): string {
  if (pathname.startsWith("/_next/") || pathname.startsWith("/docs/") || /\.[A-Za-z0-9]{1,5}$/.test(pathname)) return "static";
  const parts = pathname.split("/").filter(Boolean).slice(0, 6).map((s) => (ID_SEGMENT.test(s) ? ":id" : s.length > 40 ? ":long" : s));
  return "/" + parts.join("/");
}

const seen = new Set<string>();
function boundedRoute(pathname: string): string {
  const r = routeTemplate(pathname);
  if (seen.has(r)) return r;
  if (seen.size >= MAX_ROUTES) return "/other";
  seen.add(r);
  return r;
}

const statusClass = (code: number) => `${Math.floor(code / 100)}xx`;

type Emit = (this: http.Server, event: string | symbol, ...args: unknown[]) => boolean;

export function installHttpObserver(): void {
  const g = globalThis as { __curfHttpObserver?: boolean };
  if (g.__curfHttpObserver) return;
  g.__curfHttpObserver = true;

  const original = http.Server.prototype.emit as Emit;
  http.Server.prototype.emit = function (this: http.Server, event: string | symbol, ...args: unknown[]): boolean {
    if (event !== "request") return original.call(this, event, ...args);
    const req = args[0] as http.IncomingMessage;
    const res = args[1] as http.ServerResponse;
    let route = "/other";
    let method = "GET";
    let requestId = "";
    const t0 = process.hrtime.bigint();
    try {
      requestId = requestIdFrom(req.headers["x-request-id"]);
      res.setHeader("x-request-id", requestId);
      method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(req.method ?? "") ? (req.method as string) : "OTHER";
      route = boundedRoute((req.url ?? "/").split("?")[0]);
      res.once("close", () => {
        try {
          const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
          const aborted = !res.writableFinished;
          const code = aborted ? "aborted" : statusClass(res.statusCode);
          httpRequests.inc?.({ method, route, code });
          httpRequestSeconds.observe?.({ method, route }, seconds);
          if (code === "5xx" || aborted || seconds * 1000 > SLOW_MS) {
            const level = code === "5xx" ? "error" : "warn";
            log[level](aborted ? "request aborted" : code === "5xx" ? "request failed" : "slow request", { method, route, status: res.statusCode, ms: Math.round(seconds * 1000) });
          }
        } catch { /* observing a request must never break it */ }
      });
    } catch { /* same */ }
    if (!requestId) return original.call(this, event, ...args);
    return withLogContext({ requestId, route }, () => original.call(this, event, ...args));
  } as typeof http.Server.prototype.emit;
}
