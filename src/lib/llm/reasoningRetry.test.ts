/**
 * callLLM's widened retry after REASONING_BUDGET_EXHAUSTED.
 *
 * The bug this exists for: call sites size maxTokens for the answer they
 * expect — 120 for a chart caption, 200 for a 280-character "Why?" narrative
 * — which is correct for a non-reasoning model and fatal for a reasoning one,
 * where hidden thinking tokens come out of the SAME ceiling before any
 * visible output. Those features then never worked on that model, and the UI
 * told the user their API key was missing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const call = vi.fn();

vi.mock("@/lib/db", () => ({ prisma: { llmTokenUsage: { create: () => ({ catch: () => null }) } } }));
vi.mock("@/lib/metrics", () => ({ llmTokens: { inc: () => {} } }));
vi.mock("./pricing", () => ({ computeMicroCost: () => 0 }));
vi.mock("./credentials", () => ({
  getLlmCredentials: async () => ({ provider: "anthropic", apiKey: "k", model: "m", baseUrl: null }),
  hasEnvLlm: () => true,
}));
vi.mock("./providers/anthropic", () => ({
  anthropicDriver: { id: "anthropic", defaultModel: "m", needsBaseUrl: false, call: (...a: any[]) => call(...a) },
}));
vi.mock("./providers/openai", () => ({ openaiDriver: { id: "openai", defaultModel: "m", call: () => {} } }));
vi.mock("./providers/gemini", () => ({ geminiDriver: { id: "gemini", defaultModel: "m", call: () => {} } }));
vi.mock("./providers/openai-compatible", () => ({
  openaiCompatibleDriver: { id: "openai-compatible", defaultModel: "m", needsBaseUrl: true, call: () => {} },
}));

const { callLLM } = await import("./index");

const failed = (error: string) => ({
  text: "", provider: "anthropic" as const, model: "m", status: "failed" as const,
  error, usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 1,
});
const ok = (text: string) => ({
  text, provider: "anthropic" as const, model: "m", status: "ok" as const,
  usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1,
});
const req = (maxTokens: number) => ({
  tenantId: "t1", kind: "why" as const, system: "s",
  messages: [{ role: "user" as const, content: "u" }], maxTokens,
});

beforeEach(() => call.mockReset());

describe("reasoning-budget retry", () => {
  it("retries once with a wider ceiling and returns the answer", () => {
    call.mockResolvedValueOnce(failed("REASONING_BUDGET_EXHAUSTED: no content emitted"))
        .mockResolvedValueOnce(ok("Display spent $184K, 31% of total."));
    return callLLM(req(200) as any).then((r) => {
      expect(r.status).toBe("ok");
      expect(r.text).toContain("$184K");
      expect(call).toHaveBeenCalledTimes(2);
      // The retry must actually raise the ceiling — retrying at the same
      // budget just burns a second call on the identical failure.
      expect(call.mock.calls[1][0].maxTokens).toBeGreaterThan(call.mock.calls[0][0].maxTokens);
    });
  });

  it("does not retry other failures", () => {
    // A bad key or a rate limit is not fixed by more tokens, and retrying
    // a 401 doubles the latency of every failure for nothing.
    call.mockResolvedValue(failed("401 invalid api key"));
    return callLLM(req(200) as any).then((r) => {
      expect(r.status).toBe("failed");
      expect(call).toHaveBeenCalledTimes(1);
    });
  });

  it("does not retry when the caller already asked for a wide ceiling", () => {
    // Past the ceiling the retry would use, a second identical call adds
    // nothing — lib/agent/structured.ts owns escalation above this band.
    call.mockResolvedValue(failed("REASONING_BUDGET_EXHAUSTED"));
    return callLLM(req(8000) as any).then(() => {
      expect(call).toHaveBeenCalledTimes(1);
    });
  });

  it("leaves a successful first call alone", () => {
    call.mockResolvedValueOnce(ok("fine"));
    return callLLM(req(120) as any).then((r) => {
      expect(r.text).toBe("fine");
      expect(call).toHaveBeenCalledTimes(1);
    });
  });
});
