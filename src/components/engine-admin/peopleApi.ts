/** The browser's calls to the engine attribute routes. One place for the request shape and for turning a failure into text. */
export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; data: Record<string, unknown>; error: string };

export async function engineApi<T = Record<string, unknown>>(method: "GET" | "POST" | "PUT", url: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, status: res.status, data: data as T };
    const error = typeof data?.error === "string" ? data.error : `HTTP ${res.status}`;
    return { ok: false, status: res.status, data: (data ?? {}) as Record<string, unknown>, error };
  } catch (e) {
    return { ok: false, status: 0, data: {}, error: e instanceof Error ? e.message : String(e) };
  }
}
