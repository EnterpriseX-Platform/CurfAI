/**
 * Everything Curf says to the Java engine, as the person asking.
 *
 * `engineCall` is the one place a request leaves for an engine: it checks the URL rules, picks a connection that
 * can only reach a public address (unless the operator trusts the host), signs a one-minute token for this
 * person and workspace, applies a timeout, never follows a redirect, and retries once when the engine says it
 * is busy. Every feature that talks to an engine (queries, the view catalogue, the connection test, view and
 * policy administration) goes through it, so the security rules live here once.
 *
 * `runEngineQuery` is the report path: a query on an engine data source names a published *view* plus structured
 * parts (columns, filters, grouping, aggregates, ordering, limit) — never SQL. The engine applies the caller's row
 * rules and personal-data masking before any of it, so what comes back is exactly what that person may see.
 * Messages here are short and never carry the token; the runner stores them in the query's provenance.
 *
 * Contract: engines/contracts/engine-v1.openapi.yaml.
 */
import type { Row } from "@/lib/reporting/interpolate";
import type { EngineQuery } from "@/lib/reporting/schema";
import { mintEngineToken, type EngineViewer } from "@/lib/engine/identity";
import { engineUrlPolicy, type EngineTarget } from "@/lib/connections/engine";
import { pinnedPublicFetch } from "@/lib/security/pinnedFetch";
import { ENGINE_REASON } from "@/lib/engine/reasons";

export const ENGINE_REQUEST_TIMEOUT_MS = 30_000;
/** When the engine says it is busy, wait this long at most before the single retry. */
export const ENGINE_RETRY_MAX_WAIT_MS = 2_000;
/** The most of an engine's answer Curf will read. Curf's own row cap (200,000 rows) fits well inside it. */
export const ENGINE_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

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

/** The engine's own explanation of a refusal (RFC 9457), first message only and kept short. */
export async function engineProblemMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: string; errors?: Array<{ message?: string }> };
    const first = body.errors?.[0]?.message;
    return (first ?? body.detail ?? "").toString().slice(0, 200);
  } catch {
    return "";
  }
}

export type EngineFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<Response>;

const plainFetch: EngineFetch = (url, init) => fetch(url, { ...init, redirect: "manual" });
const pinnedFetch: EngineFetch = (url, init) => pinnedPublicFetch(url, { ...init, maxBytes: ENGINE_MAX_RESPONSE_BYTES });

/**
 * An engine's answer as JSON, refusing one larger than `maxBytes` instead of holding it. The pinned connection
 * stops at its own cap while reading; a plain connection (the platform's engine, an operator-listed host) is
 * read here, so a misbehaving engine cannot make Curf buffer more than this in a request.
 */
export async function engineJson(res: Response, maxBytes = ENGINE_MAX_RESPONSE_BYTES): Promise<any> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("The engine's answer is larger than Curf will read.");
  if (!res.body) return res.json();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("The engine's answer is larger than Curf will read.");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function audienceOf(baseUrl: string): string | undefined {
  try { return new URL(baseUrl).origin; } catch { return undefined; }
}

export type EngineCallOptions = {
  target: EngineTarget;
  viewer: EngineViewer;
  tenantId: string;
  path: string; // under /engine/v1, for example "/queries/execute"
  method?: string;
  body?: unknown;
  timeoutMs?: number;
  /** A read that is safe to repeat: allows one retry when the engine says it is busy. */
  idempotent?: boolean;
  /** For tests: replaces the transport the policy would pick. */
  fetchImpl?: EngineFetch;
};

/**
 * One request to the engine. Returns the response for the caller to read; throws only for what is not the engine's
 * answer: the URL is not allowed, the engine could not be reached, or it did not answer in time.
 */
export async function engineCall(opts: EngineCallOptions): Promise<Response> {
  const { target } = opts;

  // Which transport: the platform's own engine, and a host the operator listed, are trusted as written; a
  // workspace's URL goes over a connection that can only reach a public address, checked on the address it uses.
  let transport: EngineFetch = plainFetch;
  if (target.source === "workspace") {
    const policy = engineUrlPolicy(target.baseUrl);
    if (!policy.ok) throw new Error(`The engine URL is not allowed: ${policy.reason}`);
    if (!policy.trusted) transport = pinnedFetch;
  }
  if (opts.fetchImpl) transport = opts.fetchImpl;

  const method = (opts.method ?? "GET").toUpperCase();
  const url = `${target.baseUrl}/engine/v1${opts.path}`;
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const canRetry = opts.idempotent === true || method === "GET";

  for (let attempt = 0; ; attempt++) {
    // A new token each time: one minute is plenty, and a retry should not ride on a nearly-expired one.
    // The token names the engine it is for, by default its own address, so one captured from a workspace's own
    // server is of no use against another engine that checks the audience. An explicit audience wins.
    const token = mintEngineToken({ viewer: opts.viewer, tenantId: opts.tenantId, audience: target.audience ?? audienceOf(target.baseUrl) });
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await transport(url, { method, headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? ENGINE_REQUEST_TIMEOUT_MS) });
    } catch (e: any) {
      // Which private address a name resolved to is not for a viewer to read (it would map the internal network).
      if (e?.code === "ESSRF") throw new Error("The engine URL is not allowed: it does not point at a public address.");
      if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new Error(ENGINE_REASON.noAnswer.text);
      throw new Error(ENGINE_REASON.unreachable.text);
    }
    if (res.status >= 300 && res.status < 400) throw new Error(ENGINE_REASON.redirect.text);

    if ((res.status === 429 || res.status === 503) && canRetry && attempt === 0) {
      const asked = Number(res.headers.get("retry-after"));
      await sleep(Math.min(Number.isFinite(asked) && asked > 0 ? asked * 1000 : 500, ENGINE_RETRY_MAX_WAIT_MS));
      continue;
    }
    return res;
  }
}

/** A short, specific message for an answer that is not a success; null when `res` is ok. */
export async function engineStatusError(res: Response, subject = "request"): Promise<string | null> {
  if (res.ok) return null;
  if (res.status === 401) return ENGINE_REASON.identity.text;
  if (res.status === 403) return ENGINE_REASON.forbidden.text;
  if (res.status === 404) return ENGINE_REASON.notAvailable.text;
  if (res.status === 429) return ENGINE_REASON.busy.text;
  if (res.status === 503) return ENGINE_REASON.notReady.text;
  if (res.status === 504) return ENGINE_REASON.timeLimit.text;
  if (res.status === 422) return `The engine rejected the ${subject}: ${(await engineProblemMessage(res)) || `invalid ${subject}`}`;
  return `The engine failed to answer (${res.status}).`;
}

export async function runEngineQuery(opts: {
  target: EngineTarget;
  viewer: EngineViewer;
  tenantId: string;
  query: EngineQuery;
  params: Record<string, unknown>;
  timeoutMs?: number;
  fetchImpl?: EngineFetch;
}): Promise<Row[]> {
  const { query } = opts;
  const body: Record<string, unknown> = { viewId: query.viewId };
  if (query.columns?.length) body.columns = query.columns;
  const filters = resolveEngineFilters(query.filters, opts.params);
  if (filters.length) body.filters = filters;
  if (query.groupBy?.length) body.groupBy = query.groupBy;
  if (query.aggregates?.length) body.aggregates = query.aggregates;
  if (query.orderBy?.length) body.orderBy = query.orderBy;
  if (query.limit) body.limit = query.limit;

  const res = await engineCall({
    target: opts.target, viewer: opts.viewer, tenantId: opts.tenantId,
    method: "POST", path: "/queries/execute", body, idempotent: true,
    timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl,
  });
  const problem = await engineStatusError(res, "query");
  if (problem) {
    // The report path keeps its own wording for the two answers a reader is most likely to meet.
    if (res.status === 404) throw new Error(ENGINE_REASON.viewNotAvailable.text);
    if (res.status === 403) throw new Error(ENGINE_REASON.forbiddenQuery.text);
    throw new Error(problem);
  }
  return rowsFromEngineResult(await engineJson(res));
}
