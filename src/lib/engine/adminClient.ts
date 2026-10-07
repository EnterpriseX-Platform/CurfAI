/**
 * The browser's side of Curf's engine admin proxy (/api/engine/admin/...): one place that builds the call, reads
 * the answer and turns the engine's RFC 9457 problem into something a screen can show next to the right input.
 *
 * Nothing here talks to the engine directly. A request body can hold a database password, so it is only ever
 * sent as the body and never put in an address, a log line or an error message.
 */

export type PiiMode = "NONE" | "MASK" | "HIDE";
export type TlsMode = "VERIFY" | "REQUIRE" | "DISABLE";
export type ConnectionKind = "POSTGRESQL" | "MYSQL" | "MARIADB" | "ORACLE" | "SQLSERVER" | "TRINO";

export type EngineConnection = {
  id: string;
  name: string;
  kind: ConnectionKind;
  host: string;
  port: number;
  database: string;
  username: string;
  tlsMode: TlsMode;
  allowRawSql: boolean;
  readOnlyVerified: boolean;
  hasPassword: boolean;
  version: number;
  updatedAt?: string;
  updatedBy?: string;
};

export type ConnectionTestResult = {
  ok: boolean;
  latencyMs: number;
  serverVersion: string;
  readOnlyVerified: boolean;
  warnings: string[];
};

export type IntrospectedColumn = { name: string; type: string; nullable: boolean; piiSuggestion: PiiMode };
export type IntrospectedTable = { name: string; type: string; columns: IntrospectedColumn[] };
export type Introspection = { truncated: boolean; schemas: { name: string; tables: IntrospectedTable[] }[] };

export type EngineViewColumn = { name: string; type: string; label?: string; description?: string; pii: PiiMode };
export type RlsOperator = "EQ" | "IN";
export type RlsRule = { column: string; operator: RlsOperator; attribute: string };

export type EngineView = {
  id: string;
  name: string;
  description?: string;
  connectionId: string;
  sql: string;
  columns: EngineViewColumn[];
  allowedRoles?: string[];
  piiRoles?: string[];
  bypassRoles?: string[];
  rlsRules?: RlsRule[];
  refreshSeconds?: number | null;
  version: number;
  publishedVersion?: number | null;
  updatedAt?: string;
  updatedBy?: string;
};

export type ViewVersion = { version: number; publishedAt: string; publishedBy: string };

export type QueryResult = {
  columns: { name: string; type: string }[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  asOf: string;
};

export type Page<T> = { content: T[]; page: number; size: number; totalElements: number };

/** What went wrong, in the terms a screen needs. */
export type EngineProblem = {
  status: number;
  /** The engine's own sentence (or Curf's, for a gateway error); null when it sent none. */
  message: string | null;
  code: string | null;
  /** The engine's per-field messages, by the field name it used (e.g. "sql", "rlsRules[0].column"). */
  fields: Record<string, string[]>;
  /** Someone else changed it since it was opened (409 CURF_STALE_VERSION). */
  stale: boolean;
  /** The engine could not be reached, or did not accept Curf's token. */
  unreachable: boolean;
};

export type AdminResult<T> = { ok: true; status: number; data: T } | { ok: false; problem: EngineProblem };

const MAX_TEXT = 600;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_TEXT) : null;
}

export function parseProblem(status: number, body: unknown): EngineProblem {
  const obj = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const fields: Record<string, string[]> = {};
  if (Array.isArray(obj.errors)) {
    for (const entry of obj.errors) {
      if (!entry || typeof entry !== "object") continue;
      const field = text((entry as Record<string, unknown>).field) ?? "";
      const message = text((entry as Record<string, unknown>).message);
      if (message) (fields[field] ??= []).push(message);
    }
  }
  const code = text(obj.code);
  return {
    status,
    message: text(obj.detail) ?? text(obj.error) ?? text(obj.title),
    code,
    fields,
    stale: status === 409 && code === "CURF_STALE_VERSION",
    unreachable: status === 0 || status === 502,
  };
}

/** /api/engine/admin/<engine path>?dataSourceId=..&page=..&size=.. — only the parameters the proxy forwards. */
export function adminUrl(dataSourceId: string, path: string, query?: { page?: number; size?: number }): string {
  const params = new URLSearchParams({ dataSourceId });
  if (query?.page !== undefined) params.set("page", String(query.page));
  if (query?.size !== undefined) params.set("size", String(query.size));
  return `/api/engine/admin${path.startsWith("/") ? path : `/${path}`}?${params.toString()}`;
}

export type AdminCallOptions = {
  body?: unknown;
  query?: { page?: number; size?: number };
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

export async function adminCall<T = unknown>(dataSourceId: string, method: string, path: string, opts: AdminCallOptions = {}): Promise<AdminResult<T>> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(adminUrl(dataSourceId, path, opts.query), {
      method,
      headers: opts.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") throw e;
    return { ok: false, problem: { status: 0, message: null, code: null, fields: {}, stale: false, unreachable: true } };
  }
  if (res.status === 204) return { ok: true, status: 204, data: undefined as T };
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, problem: parseProblem(res.status, payload) };
  return { ok: true, status: res.status, data: payload as T };
}

/** Every item of a paged engine list (up to 10 pages of 200), for screens that need the whole set. */
export async function adminList<T>(dataSourceId: string, path: string, opts: Pick<AdminCallOptions, "fetchImpl" | "signal"> = {}): Promise<AdminResult<T[]>> {
  const items: T[] = [];
  for (let page = 0; page < 10; page++) {
    const res = await adminCall<Page<T>>(dataSourceId, "GET", path, { ...opts, query: { page, size: 200 } });
    if (!res.ok) return res;
    const content = Array.isArray(res.data?.content) ? res.data.content : [];
    items.push(...content);
    if (content.length < 200 || items.length >= (res.data.totalElements ?? 0)) break;
  }
  return { ok: true, status: 200, data: items };
}

/** Every message for a field, including its indexed children ("rlsRules" covers "rlsRules[0].column"). */
export function fieldMessages(problem: EngineProblem | null, field: string): string[] {
  if (!problem) return [];
  const out: string[] = [];
  for (const [name, messages] of Object.entries(problem.fields)) {
    if (name === field || name.startsWith(`${field}[`) || name.startsWith(`${field}.`)) out.push(...messages);
  }
  return out;
}
