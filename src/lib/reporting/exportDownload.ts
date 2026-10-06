/**
 * Client side of the routes that answer with a rendered report file: the
 * export routes (/api/reports/:id/export/*) and a schedule's "Run now"
 * (POST /api/schedules/:id/run).
 *
 * The export menus used to be plain <a href> links, so any non-OK answer
 * replaced the tab with the route's raw JSON: the 503 the routes send while
 * the shared headless browser is saturated (renderers/headlessBrowser.ts),
 * a failed capture's 500, CSV's 400 for a report with no table. Fetching
 * the file instead lets the caller show a toast. No React or DOM here, so
 * the response handling and the toast wording are unit-tested;
 * useReportExport() does the rest.
 */
import { filenameFromDisposition } from "@/lib/http/contentDisposition";

export type ExportFormat = "pdf" | "xlsx" | "docx" | "csv";

export type ExportResult =
  | { ok: true; blob: Blob; filename: string }
  /** 503: the renderer is saturated. Nothing ran, so retrying later works. */
  | { ok: false; kind: "busy"; retryAfterSec: number | null }
  /** Any other non-OK answer. `message` is the route's `error`, if it sent one. */
  | { ok: false; kind: "failed"; message: string | null }
  | { ok: false; kind: "network" };

/** Filter values ride along as p.<name>, which parseParams() reads back.
 *  Relative, so it's safe to build during a server render. */
export function reportExportUrl(reportId: string, format: ExportFormat, params?: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v != null && v !== "") qs.set(`p.${k}`, String(v));
  }
  const path = `/api/reports/${reportId}/export/${format}`;
  const query = qs.toString();
  return query ? `${path}?${query}` : path;
}

/** `init` is for routes that aren't a plain GET, e.g. { method: "POST" } for a schedule run. */
export async function fetchExport(url: string, fallbackName: string, init?: RequestInit): Promise<ExportResult> {
  try {
    const r = await fetch(url, init);
    if (r.status === 503) {
      return { ok: false, kind: "busy", retryAfterSec: retryAfterSeconds(r.headers.get("retry-after")) };
    }
    if (!r.ok) {
      // Not every failure is JSON: an unhandled throw or a proxy error page isn't.
      const body = await r.json().catch(() => null);
      const message = typeof body?.error === "string" && body.error ? body.error : null;
      return { ok: false, kind: "failed", message };
    }
    const blob = await r.blob();
    return { ok: true, blob, filename: filenameFromDisposition(r.headers.get("content-disposition")) ?? fallbackName };
  } catch {
    return { ok: false, kind: "network" };
  }
}

/**
 * The toast for a failed fetchExport(). A busy renderer reads the same
 * wherever the file was asked for; `failedTitle` names what failed
 * ("Couldn't export PDF", "Run failed"). `t` is useT()'s.
 */
export function exportFailureToast(res: Extract<ExportResult, { ok: false }>, t: (key: string) => string, failedTitle: string) {
  if (res.kind === "busy") {
    return {
      variant: "destructive" as const,
      title: t("export.busyTitle"),
      description: res.retryAfterSec
        ? t("export.busyRetryIn").replace("{n}", String(res.retryAfterSec))
        : t("export.busyRetryLater"),
    };
  }
  return {
    variant: "destructive" as const,
    title: failedTitle,
    description: res.kind === "network" ? t("export.networkError") : res.message ?? t("export.failedGeneric"),
  };
}

/** Retry-After as delta-seconds, the form browserBusyResponse() sends. */
function retryAfterSeconds(v: string | null): number | null {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
}
