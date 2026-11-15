/**
 * A platform model with queue limits (the trial model on a shared host): a short call that finds the queue full is
 * refused at once with the TRIAL_MODEL_BUSY marker, a long job's calls keep their place in line, and a long job is
 * not started while the lane is full and waiting.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const call = vi.fn();
const creds = { current: null as any };

vi.mock("@/lib/db", () => ({ prisma: { llmTokenUsage: { create: () => ({ catch: () => null }) } } }));
vi.mock("@/lib/metrics", () => ({ llmTokens: { inc: () => {} } }));
vi.mock("./pricing", () => ({ computeMicroCost: () => 0, computeMicroCostMetered: () => 0 }));
vi.mock("@/lib/billing", () => ({ requireAiCredits: async () => null }));
vi.mock("./credentials", () => ({ getLlmCredentials: async () => creds.current, hasEnvLlm: () => true }));
vi.mock("./providers/anthropic", () => ({ anthropicDriver: { id: "anthropic", defaultModel: "m", call: () => {} } }));
vi.mock("./providers/openai", () => ({ openaiDriver: { id: "openai", defaultModel: "m", call: () => {} } }));
vi.mock("./providers/gemini", () => ({ geminiDriver: { id: "gemini", defaultModel: "m", call: () => {} } }));
vi.mock("./providers/openai-compatible", () => ({
  openaiCompatibleDriver: { id: "openai-compatible", defaultModel: "m", needsBaseUrl: true, call: (...a: any[]) => call(...a) },
}));

const { callLLM, requireModelCapacityFor } = await import("./index");
const { acquireSlot, laneKey, laneState } = await import("./resilience");

const trial = (over: Record<string, unknown> = {}) => ({
  provider: "openai-compatible", apiKey: "k", model: "qwen", fastModel: null, baseUrl: "https://athena.test/v1", source: "env",
  trial: true, maxQueue: 1, maxWaitSec: null, ...over,
});
const ok = () => ({ text: "fine", provider: "openai-compatible", model: "m", status: "ok", usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 });
const req = (kind: string) => ({ tenantId: "t1", kind, system: "s", messages: [{ role: "user" as const, content: "u" }], maxTokens: 100 });

let n = 0;
let base: string;
beforeEach(() => {
  call.mockReset();
  process.env.CURF_LLM_CONCURRENCY = "1";
  base = `https://athena${++n}.test/v1`; // a lane of its own per test
  creds.current = trial({ baseUrl: base });
});

/** Take the lane's only slot and leave `queued` callers waiting behind it. */
async function fillLane(queued: number) {
  const key = laneKey("openai-compatible", base);
  const held = await acquireSlot(key, 1);
  const waiting = Array.from({ length: queued }, () => acquireSlot(key, 1));
  return { held, waiting, key };
}

describe("a trial model's queue", () => {
  it("refuses a short call at once when the queue is full, without calling the host", async () => {
    const { held, waiting } = await fillLane(1);
    const r = await callLLM(req("ask"));
    expect(r.status).toBe("failed");
    expect(r.error).toContain("TRIAL_MODEL_BUSY");
    expect(call).not.toHaveBeenCalled();
    held();
    for (const w of waiting) (await w)();
  });

  it("lets a short call queue while there is room", async () => {
    call.mockResolvedValue(ok());
    const { held, waiting, key } = await fillLane(0);
    const p = callLLM(req("ask"));
    await new Promise((r) => setImmediate(r));
    expect(laneState(key).queued).toBe(1);
    held();
    expect((await p).status).toBe("ok");
    expect(waiting).toHaveLength(0);
  });

  it("never refuses the calls of a long job: they wait their turn", async () => {
    call.mockResolvedValue(ok());
    const { held, waiting, key } = await fillLane(1);
    const p = callLLM(req("master_builder_design"));
    await new Promise((r) => setImmediate(r));
    expect(laneState(key).queued).toBe(2);
    held();
    (await waiting[0])();
    expect((await p).status).toBe("ok");
  });
});

describe("starting a long job", () => {
  it("is refused with a 503 while the lane is full and waiting, and allowed once it clears", async () => {
    creds.current = trial({ baseUrl: base, maxQueue: 3 }); // a third of 3 = 1 waiting
    const { held, waiting } = await fillLane(1);
    const res = await requireModelCapacityFor("t1");
    expect(res?.status).toBe(503);
    expect(res?.headers.get("Retry-After")).toBe("120");
    expect((await res!.json()).code).toBe("trial_model_busy");
    held();
    for (const w of waiting) (await w)();
    expect(await requireModelCapacityFor("t1")).toBeNull();
  });

  it("is never refused on a model with no limit, or on the workspace's own key", async () => {
    const { held, waiting } = await fillLane(3);
    creds.current = trial({ baseUrl: base, maxQueue: null });
    expect(await requireModelCapacityFor("t1")).toBeNull();
    creds.current = trial({ baseUrl: base, source: "tenant" });
    expect(await requireModelCapacityFor("t1")).toBeNull();
    held();
    for (const w of waiting) (await w)();
  });
});
