/**
 * Turn URL search params into a typed parameter bag based on the report's
 * parameter schema. Used by viewer + export routes.
 *
 * Convention: URL params are prefixed with `p.` to avoid collisions
 * (e.g. /reports/abc?p.from=2026-01-01&p.to=2026-12-31).
 */
import type { Parameter } from "@/lib/reporting/schema";

/**
 * Every `:name` placeholder referenced in a raw SQL string (same pattern
 * bindParams() in runner.ts scans for). Used by the dashboard top-KPI strip
 * to bind whichever drill-dimension names a KPI's own SQL happens to
 * reference, instead of a fixed list — a KPI written against one topic's
 * columns (e.g. "school") would otherwise throw "Missing parameter" the
 * moment a different topic's dashboard (whose KPIs never mention "school")
 * shares this code path with one that does.
 */
export function extractSqlParamNames(sql: string): string[] {
  const names = new Set<string>();
  sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, p1) => { names.add(p1); return _m; });
  return [...names];
}

export function parseParams(
  url: URL,
  parameters: Parameter[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of parameters) {
    const raw = url.searchParams.get(`p.${p.name}`);
    if (raw == null || raw === "") {
      // Every declared parameter must come out bound to something — see
      // defaultParamValues()'s comment just below. Leaving a parameter out
      // of the object entirely (the old behaviour when it had no `default`)
      // left its `:name` placeholder unbound, which SQLite binds as NULL;
      // `(:site = '' OR site_code = :site)` then matches nothing and the
      // export silently comes back with zero rows in every data source —
      // a 200, a plausible-looking file, and no data in it. XLSX/DOCX/CSV
      // export call this directly into runReport() and hit exactly that;
      // PDF export was never affected, since it replays the interactive
      // viewer's own URL through Puppeteer rather than calling this.
      out[p.name] = p.default ?? "";
      continue;
    }
    if (p.type === "number") out[p.name] = Number(raw);
    else if (p.type === "boolean") out[p.name] = raw === "true";
    else out[p.name] = raw;
  }
  return out;
}

/**
 * Same fallback reports/[id]/page.tsx uses per-parameter (`v ?? p.default ??
 * ""`), for a caller with no URL to read an override from — loadBrief runs
 * a report definition directly, not behind a request. Every declared
 * parameter always gets a bound value: a report whose SQL reads `(:site =
 * '' OR site_code = :site)` for "no filter" needs `site` bound to `""`,
 * not left out of the params object entirely — an unbound `:name` binds as
 * NULL, and `NULL = ''` is neither true nor false in SQL, so the WHERE
 * clause matches nothing and every aggregate silently comes back empty.
 */
export function defaultParamValues(parameters: Parameter[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of parameters) out[p.name] = p.default ?? "";
  return out;
}
