/**
 * callLLM's handling of transport failures on the HTTP drivers: retry with
 * backoff when the provider (429/5xx/dropped connection/timeout) is at
 * fault, a per-endpoint concurrency limit, and leaving every other
 * provider and every non-transient failure alone.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const call = vi.fn();
const anthropicCall = vi.fn();
const usageRows: any[] = [];
const state = { provider: "openai-compatible" };

vi.mock("@/lib/db", () => ({ prisma: { llmTokenUsage: { create: (a: any) => { usageRows.push(a.data); return { catch: () => null }; } } } }));
vi.mock("@/lib/metrics", () => ({ llmTokens: { inc: () => {} } }));
vi.mock("./pricing", () => ({ computeMicroCost: () => 0, computeMicroCostMetered: () => 0 }));
vi.mock("@/lib/billing", () => ({ requireAiCredits: async () => null }));
vi.mock("./credentials", () => ({
  getLlmCredentials: async () => ({ provider: state.provider, apiKey: "k", model: "m", baseUrl: "https://llm.test/v1", source: "tenant" }),
  hasEnvLlm: () => true,
}));
vi.mock("./providers/anthropic", () => ({
  anthropicDriver: { id: "anthropic", defaultModel: "m", call: (...a: any[]) => anthropicCall(...a) },
}));
vi.mock("./providers/openai", () => ({ openaiDriver: { id: "openai", defaultModel: "m", call: () => {} } }));
vi.mock("./providers/gemini", () => ({ geminiDriver: { id: "gemini", defaultModel: "m", call: () => {} } }));
vi.mock("./providers/openai-compatible", () => ({
  openaiCompatibleDriver: { id: "openai-compatible", defaultModel: "m", needsBaseUrl: true, call: (...a: any[]) => call(...a) },
}));
vi.mock("./resilience", async (orig) => {
  const real: any = await orig();
  // No real waiting in unit tests; keep the policy functions.
  return { ...real, abortableSleep: async (_ms: number, signal?: AbortSignal) => !signal?.aborted, backoffMs: () => 1 };
});

const { callLLM } = await import("./index");

const fail = (over: Record<string, unknown>) => ({
  text: "", provider: "openai-compatible" as const, model: "m", status: "failed" as const,
  error: "boom", usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 1, ...over,
});
const ok = (text = "fine") => ({
  text, provider: "openai-compatible" as const, model: "m", status: "ok" as const,
  usage: { inputTokens: 5, outputTokens: 7 }, durationMs: 1,
});
const req = (extra: Record<string, unknown> = {}) => ({
  tenantId: "t1", kind: "master_builder_design", system: "s",
  messages: [{ role: "user" as const, content: "u" }], maxTokens: 500, ...extra,
});

beforeEach(async () => {
  await new Promise((r) => setImmediate(r)); // let the last test's usage writes land before clearing
  call.mockReset(); anthropicCall.mockReset(); usageRows.length = 0; state.provider = "openai-compatible";
  delete process.env.CURF_LLM_RETRIES; delete process.env.CURF_LLM_CONCURRENCY;
});

describe("transport retry", () => {
  it("retries a 429 and returns the answer, reporting the attempts", async () => {
    call.mockResolvedValueOnce(fail({ error: "HTTP 429: slow down", httpStatus: 429, retryable: true, retryAfterMs: 1000 }))
        .mockResolvedValueOnce(ok());
    const r = await callLLM(req() as any);
    expect(r.status).toBe("ok");
    expect(r.attempts).toBe(2);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("gives up after CURF_LLM_RETRIES extra attempts and says so", async () => {
    process.env.CURF_LLM_RETRIES = "1";
    call.mockResolvedValue(fail({ error: "HTTP 503: down", httpStatus: 503, retryable: true }));
    const r = await callLLM(req() as any);
    expect(r.status).toBe("failed");
    expect(r.attempts).toBe(2);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("does not retry a failure the driver did not flag (401, bad request, unparseable)", async () => {
    call.mockResolvedValue(fail({ error: "HTTP 401: bad key", httpStatus: 401 }));
    const r = await callLLM(req() as any);
    expect(r.status).toBe("failed");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("retries a timeout once, with 1.5x the room, and no more than once", async () => {
    call.mockResolvedValue(fail({ error: "Request timed out after 90s", timedOut: true, retryable: true }));
    const r = await callLLM(req({ timeoutMs: 100_000 }) as any);
    expect(r.status).toBe("failed");
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0][0].timeoutMs).toBe(100_000);
    expect(call.mock.calls[1][0].timeoutMs).toBe(150_000);
  });

  it("leaves a failed attempt in the usage log, classified as a timeout", async () => {
    call.mockResolvedValueOnce(fail({ error: "Request timed out after 90s", timedOut: true, retryable: true })).mockResolvedValueOnce(ok());
    await callLLM(req() as any);
    await new Promise((r) => setImmediate(r));
    expect(usageRows.map((u) => [u.status, u.errorKind])).toEqual([["failed", "timeout"], ["ok", null]]);
  });

  it("never retries a provider whose driver does not opt in (Anthropic)", async () => {
    state.provider = "anthropic";
    anthropicCall.mockResolvedValue({ ...fail({ error: "HTTP 529 overloaded", retryable: true }), provider: "anthropic" });
    const r = await callLLM(req() as any);
    expect(r.status).toBe("failed");
    expect(anthropicCall).toHaveBeenCalledTimes(1);
  });

  it("stops retrying when the caller aborts", async () => {
    const ac = new AbortController();
    call.mockImplementation(async () => { ac.abort(); return fail({ error: "HTTP 502", httpStatus: 502, retryable: true }); });
    const r = await callLLM(req({ signal: ac.signal }) as any);
    expect(r.status).toBe("failed");
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe("concurrency limit", () => {
  it("never has more than CURF_LLM_CONCURRENCY calls in flight to one endpoint", async () => {
    process.env.CURF_LLM_CONCURRENCY = "2";
    let inFlight = 0, peak = 0;
    call.mockImplementation(async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return ok();
    });
    const rs = await Promise.all(Array.from({ length: 6 }, () => callLLM(req() as any)));
    expect(rs.every((r) => r.status === "ok")).toBe(true);
    expect(peak).toBe(2);
  });
});

describe("thinking cap hand-off", () => {
  it("a cut-off thinker goes straight to the no-thinking retry (no wider-ceiling detour), and the spent attempt is logged", async () => {
    call
      .mockResolvedValueOnce(fail({ error: "REASONING_BUDGET_EXHAUSTED: stopped early", thinkingCapped: true, usage: { inputTokens: 0, outputTokens: 1800 } }))
      .mockResolvedValueOnce(ok("answer"));
    const r = await callLLM(req({ maxTokens: 3000, thinkingCap: 0.5 }) as any);
    expect(r.status).toBe("ok");
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][0].reasoning).toBe("off");
    await new Promise((r2) => setImmediate(r2));
    expect(usageRows.map((u) => [u.status, u.outputTokens, u.errorKind])).toEqual([["failed", 1800, "reasoning_budget"], ["ok", 7, null]]);
  });

  it("an ordinary exhausted budget still gets the wider ceiling first", async () => {
    call
      .mockResolvedValueOnce(fail({ error: "REASONING_BUDGET_EXHAUSTED: used it all" }))
      .mockResolvedValueOnce(ok("answer"));
    await callLLM(req({ maxTokens: 800 }) as any);
    expect(call.mock.calls[1][0].maxTokens).toBe(4000);
    expect(call.mock.calls[1][0].reasoning).not.toBe("off");
  });

  it("retryTimeouts:false leaves a timeout alone", async () => {
    call.mockResolvedValue(fail({ error: "Request timed out after 90s", timedOut: true, retryable: true }));
    await callLLM(req({ retryTimeouts: false }) as any);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
