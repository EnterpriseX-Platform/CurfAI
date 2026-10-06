/**
 * The OpenAI-compatible driver over a streamed response: the SSE body is
 * folded into the same answer a non-streamed call returns, a connection that
 * goes quiet is called stalled (and retryable) well before the wall-clock
 * ceiling, and HTTP failures say whether they are worth another try.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("@/lib/security/ssrfGuard", () => ({ guardedFetch: (...a: any[]) => fetchMock(...a) }));

const { openaiCompatibleCall, readChatStream, isNetworkError } = await import("./openai");
const call = openaiCompatibleCall("openai-compatible", "");
const ctx = { apiKey: "k", baseUrl: "https://llm.test/v1", model: "kimi-k3" };
const req = (extra: Record<string, unknown> = {}) => ({
  tenantId: "t", kind: "k", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 100, ...extra,
});

const sse = (...events: unknown[]) =>
  events.map((e) => (e === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(e)}\n\n`)).join("");
const bodyOf = (text: string, splitAt?: number) => {
  const enc = new TextEncoder();
  const parts = splitAt ? [text.slice(0, splitAt), text.slice(splitAt)] : [text];
  return new ReadableStream<Uint8Array>({
    start(c) { parts.forEach((p) => c.enqueue(enc.encode(p))); c.close(); },
  });
};

beforeEach(() => { fetchMock.mockReset(); delete process.env.CURF_LLM_STREAM; delete process.env.CURF_LLM_IDLE_MS; });
afterEach(() => { vi.useRealTimers(); });

describe("readChatStream", () => {
  it("joins content and reasoning, takes finish_reason and usage (top level or in the choice)", async () => {
    const text = sse(
      { model: "kimi-k3", choices: [{ delta: { reasoning_content: "think " } }] },
      { choices: [{ delta: { reasoning_content: "more" } }] },
      { choices: [{ delta: { content: '{"a":' } }] },
      { choices: [{ delta: { content: "1}" }, finish_reason: "stop", usage: { prompt_tokens: 11, completion_tokens: 22 } }] },
      "[DONE]",
    );
    let chunks = 0;
    const r = await readChatStream(bodyOf(text, 37), () => { chunks++; });
    expect(r.choices?.[0]?.message?.content).toBe('{"a":1}');
    expect(r.choices?.[0]?.message?.reasoning_content).toBe("think more");
    expect(r.choices?.[0]?.finish_reason).toBe("stop");
    expect(r.usage).toEqual({ prompt_tokens: 11, completion_tokens: 22 });
    expect(r.model).toBe("kimi-k3");
    expect(chunks).toBe(2);
    expect(r.firstTokenMs).toBeGreaterThanOrEqual(0);
  });

  it("ignores comments, blank lines and malformed events", async () => {
    const text = ": keep-alive\n\ndata: {not json\n\n" + sse({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }, "[DONE]");
    const r = await readChatStream(bodyOf(text), () => {});
    expect(r.choices?.[0]?.message?.content).toBe("ok");
  });
});

describe("driver, streaming (default)", () => {
  it("asks for a stream with usage and returns the assembled answer", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      body: bodyOf(sse(
        { choices: [{ delta: { reasoning_content: "hmm" } }] },
        { choices: [{ delta: { content: "pong" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 9 } },
        "[DONE]",
      )),
    });
    const r = await call(req(), ctx);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.stream).toBe(true);
    expect(sent.stream_options).toEqual({ include_usage: true });
    expect(r).toMatchObject({ status: "ok", text: "pong", usage: { inputTokens: 3, outputTokens: 9 } });
    expect(r.firstTokenMs).toBeGreaterThanOrEqual(0);
  });

  it("times the whole answer, not the wait for the first byte (headers of a stream arrive at once)", async () => {
    const enc = new TextEncoder();
    fetchMock.mockResolvedValue({
      ok: true,
      body: new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(enc.encode(sse({ choices: [{ delta: { content: "a" } }] })));
          await new Promise((r) => setTimeout(r, 60));
          c.enqueue(enc.encode(sse({ choices: [{ delta: { content: "b" }, finish_reason: "stop" }] }, "[DONE]")));
          c.close();
        },
      }),
    });
    const r = await call(req(), ctx);
    expect(r.text).toBe("ab");
    expect(r.durationMs).toBeGreaterThanOrEqual(55);
  });

  it("CURF_LLM_STREAM=off sends an ordinary request and reads the JSON body", async () => {
    process.env.CURF_LLM_STREAM = "off";
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "plain" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2 } }),
    });
    const r = await call(req(), ctx);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream).toBeUndefined();
    expect(r).toMatchObject({ status: "ok", text: "plain" });
  });

  it("an all-reasoning answer cut at max_tokens is still REASONING_BUDGET_EXHAUSTED", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      body: bodyOf(sse({ choices: [{ delta: { reasoning_content: "thinking forever" }, finish_reason: "length" }] }, "[DONE]")),
    });
    const r = await call(req(), ctx);
    expect(r.status).toBe("failed");
    expect(r.error).toContain("REASONING_BUDGET_EXHAUSTED");
  });

  it("a connection that goes quiet is stalled and retryable, long before the wall-clock ceiling", async () => {
    process.env.CURF_LLM_IDLE_MS = "5000";
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const p = call(req({ timeoutMs: 200_000 }), ctx);
    await vi.advanceTimersByTimeAsync(5_100);
    const r = await p;
    expect(r.status).toBe("failed");
    expect(r.error).toContain("stalled");
    expect(r).toMatchObject({ retryable: true, timedOut: false });
  });

  it("the wall-clock ceiling is a timeout (retryable once by callLLM)", async () => {
    process.env.CURF_LLM_IDLE_MS = "600000";
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const p = call(req({ timeoutMs: 6_000 }), ctx);
    await vi.advanceTimersByTimeAsync(6_100);
    const r = await p;
    expect(r.error).toContain("timed out");
    expect(r).toMatchObject({ retryable: true, timedOut: true });
  });
});

describe("failure flags", () => {
  it("429 and 5xx are retryable and carry Retry-After; 400/401 are not", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, text: async () => "slow down", headers: new Headers({ "retry-after": "3" }) });
    const a = await call(req(), ctx);
    expect(a).toMatchObject({ retryable: true, httpStatus: 429, retryAfterMs: 3000 });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, text: async () => "x", headers: new Headers() });
    expect(await call(req(), ctx)).toMatchObject({ retryable: true, httpStatus: 503 });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => "no", headers: new Headers() });
    expect(await call(req(), ctx)).toMatchObject({ retryable: false, httpStatus: 401 });
  });

  it("a 429 that says the account is out of credit is not throttling and is not retryable", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 429, headers: new Headers(),
      text: async () => '{"error":{"message":"account suspended due to insufficient balance","type":"exceeded_current_quota_error"}}',
    });
    expect(await call(req(), ctx)).toMatchObject({ retryable: false, httpStatus: 429 });
  });

  it("a dropped connection is retryable; an SSRF refusal is not", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }));
    expect(await call(req(), ctx)).toMatchObject({ retryable: true });
    fetchMock.mockRejectedValueOnce(new Error("Blocked: resolves to a private address"));
    expect(await call(req(), ctx)).toMatchObject({ retryable: false });
    expect(isNetworkError(new Error("anything else"))).toBe(false);
  });
});

describe("thinking cap (opt-in)", () => {
  // One network chunk per event, as a real stream arrives.
  const thinkingOnly = (chars: number) => {
    const enc = new TextEncoder();
    const events = [
      ...Array.from({ length: 10 }, () => ({ choices: [{ delta: { reasoning_content: "x".repeat(chars / 10) } }] })),
      { choices: [{ delta: { content: "{}" }, finish_reason: "stop" }] },
    ];
    return new ReadableStream<Uint8Array>({
      start(c) { events.forEach((e) => c.enqueue(enc.encode(sse(e)))); c.enqueue(enc.encode(sse("[DONE]"))); c.close(); },
    });
  };

  it("stops a model that has thought past the cap without answering, and says so", async () => {
    // cap = 0.5 * 4000 tokens = 2000 tokens ~ 7400 chars; the stream thinks 20000 chars first.
    fetchMock.mockResolvedValue({ ok: true, body: thinkingOnly(20_000) });
    const r = await call(req({ maxTokens: 4000, thinkingCap: 0.5 }), ctx);
    expect(r.status).toBe("failed");
    expect(r.error).toContain("REASONING_BUDGET_EXHAUSTED");
    expect(r.thinkingCapped).toBe(true);
    expect(r.usage.outputTokens).toBeGreaterThan(1500); // the tokens spent are still counted
  });

  it("leaves a model that answers inside the cap alone", async () => {
    fetchMock.mockResolvedValue({ ok: true, body: thinkingOnly(3_000) });
    const r = await call(req({ maxTokens: 4000, thinkingCap: 0.5 }), ctx);
    expect(r).toMatchObject({ status: "ok", text: "{}" });
  });

  it("is off unless asked for, and off for small budgets", async () => {
    fetchMock.mockResolvedValue({ ok: true, body: thinkingOnly(20_000) });
    expect((await call(req({ maxTokens: 4000 }), ctx)).status).toBe("ok");
    fetchMock.mockResolvedValue({ ok: true, body: thinkingOnly(20_000) });
    expect((await call(req({ maxTokens: 1500, thinkingCap: 0.5 }), ctx)).status).toBe("ok");
  });
});
