/**
 * Runs one Curf query on the Java engine, as the person asking.
 *
 * A query on an engine data source names a published *view* plus structured parts (columns, filters, grouping,
 * aggregates, ordering, limit) — never SQL. The engine applies the caller's row rules and personal-data masking
 * before any of it, so what comes back is exactly what that person may see. Everything the engine says about a
 * refusal ends up in the message the runner stores in the query's provenance, so messages here are short,
 * and never carry the token.
 *
 * The request is POST {engine}/engine/v1/queries/execute with `viewId` (engines/contracts/engine-v1.openapi.yaml).
 */
import type { Row } from "@/lib/reporting/interpolate";
import type { EngineQuery } from "@/lib/reporting/schema";
import { mintEngineToken, type EngineViewer } from "@/lib/engine/identity";
import { engineBaseUrlError, type EngineTarget } from "@/lib/connections/engine";

export const ENGINE_REQUEST_TIMEOUT_MS = 30_000;

type ParamRef = { $param: string };
const isParamRef = (v: unknown): v is ParamRef =>
  !!v && typeof v === "object" && typeof (v as any).$param === "string" && Object.keys(v as object).length === 1;

const isBlank = (v: unknown) => v === undefined || v === null || v === "";

/**
 * Fills `{ "$param": "name" }` values from the report's parameters, and drops a `skipIfEmpty` filter whose
 * parameter is blank — the engine's own report format, so one definition means the same on either side.
 */
export function resolveEngineFilters(
  filters: EngineQuery["filters"],
  params: Record<string, unknown>,
): Array<{ column: string; op: string; value?: unknown; values?: unknown[] }> {
  const out: Array<{ column: string; op: string; value?: unknown; values?: unknown[] }> = [];
  for (const f of filters ?? []) {
    const value = isParamRef(f.value) ? params[f.value.$param] : f.value;
    const values = f.values?.map((v) => (isParamRef(v) ? params[v.$param] : v));
    if (f.skipIfEmpty && (isBlank(value) && (values === undefined || values.every(isBlank)))) continue;
    const filter: { column: string; op: string; value?: unknown; values?: unknown[] } = { column: f.column, op: f.op };
    if (value !== undefined) filter.value = value;
    if (values !== undefined) filter.values = values;
    out.push(filter);
  }
  return out;
}

/** Rows keyed by column name, as every other Curf driver returns them. */
export function rowsFromEngineResult(result: { columns?: Array<{ name: string }>; rows?: unknown[][] }): Row[] {
  const names = (result.columns ?? []).map((c) => c.name);
  return (result.rows ?? []).map((cells) => {
    const row: Row = {};
    names.forEach((name, i) => {
      row[name] = (cells as unknown[])[i] ?? null;
    });
    return row;
  });
}

async function problemMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: string; errors?: Array<{ message?: string }> };
    const first = body.errors?.[0]?.message;
    return (first ?? body.detail ?? "").toString().slice(0, 200);
  } catch {
    return "";
  }
}

export async function runEngineQuery(opts: {
  target: EngineTarget;
  viewer: EngineViewer;
  tenantId: string;
  query: EngineQuery;
  params: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<Row[]> {
  const { target, query } = opts;

  // A workspace's own URL is re-checked on every call, so a rule that tightened after it was saved applies.
  if (target.source === "workspace") {
    const why = await engineBaseUrlError(target.baseUrl);
    if (why) throw new Error(`The engine URL is not allowed: ${why}`);
  }

  const token = mintEngineToken({ viewer: opts.viewer, tenantId: opts.tenantId, audience: target.audience });
  const body: Record<string, unknown> = { viewId: query.viewId };
  if (query.columns?.length) body.columns = query.columns;
  const filters = resolveEngineFilters(query.filters, opts.params);
  if (filters.length) body.filters = filters;
  if (query.groupBy?.length) body.groupBy = query.groupBy;
  if (query.aggregates?.length) body.aggregates = query.aggregates;
  if (query.orderBy?.length) body.orderBy = query.orderBy;
  if (query.limit) body.limit = query.limit;

  let res: Response;
  try {
    res = await fetch(`${target.baseUrl}/engine/v1/queries/execute`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      // Never follow a redirect: it could lead somewhere the URL rules did not clear.
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? ENGINE_REQUEST_TIMEOUT_MS),
    });
  } catch (e: any) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new Error("The engine did not answer in time.");
    throw new Error("The engine could not be reached.");
  }

  if (res.status >= 300 && res.status < 400) throw new Error("The engine answered with a redirect, which is not followed.");
  if (res.status === 401) throw new Error("The engine did not accept Curf's identity token (check its issuer and key settings).");
  if (res.status === 403) throw new Error("The engine does not allow this person to run queries.");
  if (res.status === 404) throw new Error("That view does not exist on the engine, is not published, or is not available to you.");
  if (res.status === 429) throw new Error("The engine is busy with your other queries. Try again in a moment.");
  if (res.status === 504) throw new Error("The query ran past the engine's time limit and was cancelled.");
  if (res.status === 422) throw new Error(`The engine rejected the query: ${(await problemMessage(res)) || "invalid request"}`);
  if (!res.ok) throw new Error(`The engine failed to answer (${res.status}).`);

  return rowsFromEngineResult(await res.json());
}
