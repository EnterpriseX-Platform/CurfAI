import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  tenant: { findUnique: vi.fn() },
  platformTierModel: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/dbContext", () => ({ withSystemDbContext: (fn: () => unknown) => fn() }));
vi.mock("@/lib/secrets", () => ({ decryptSecret: (s: string) => (s === "bad" ? null : `key:${s}`) }));

import { clearPlatformModelCache, platformModelForTier } from "./platformModels";
import { getLlmCredentials } from "./credentials";

const model = (over: Record<string, unknown> = {}) => ({
  id: "pm_kimi", provider: "openai-compatible", baseUrl: "https://api.moonshot.ai/v1", keyEnc: "k1", model: "kimi-k2.6",
  fastModel: null, thinkingOff: false, trial: false, maxQueue: null, maxWaitSec: null, inputPer1M: null, outputPer1M: null, cacheReadPer1M: null, ...over,
});
const tenant = (tier: string, own: Record<string, unknown> = {}) => ({
  tier, llmProvider: null, llmKeyEnc: null, llmModel: null, llmFastModel: null, llmBaseUrl: null, anthropicKeyEnc: null, ...own,
});

beforeEach(() => {
  clearPlatformModelCache();
  db.platformTierModel.findMany.mockReset();
  db.tenant.findUnique.mockReset();
  process.env.CURF_LLM_PROVIDER = "openai-compatible";
  process.env.CURF_LLM_KEY = "env-key";
  process.env.CURF_LLM_MODEL = "qwen-3.8-27b";
  process.env.CURF_LLM_BASE_URL = "https://athena.example/v1";
});

describe("the model a tier runs on", () => {
  it("is the platform model picked for the workspace's tier, metered at its rate", async () => {
    db.platformTierModel.findMany.mockResolvedValue([{ tier: "growth", platformModel: model({ inputPer1M: 1, outputPer1M: 4 }) }]);
    db.tenant.findUnique.mockResolvedValue(tenant("growth"));
    const c = await getLlmCredentials("t1");
    expect(c).toMatchObject({ source: "env", model: "kimi-k2.6", apiKey: "key:k1", platformModelId: "pm_kimi", rate: { inputPer1M: 1, outputPer1M: 4 } });
  });

  it("carries the trial label and the queue limits the admin set on the model", async () => {
    db.platformTierModel.findMany.mockResolvedValue([{ tier: "community", platformModel: model({ trial: true, maxQueue: 6, maxWaitSec: 90 }) }]);
    db.tenant.findUnique.mockResolvedValue(tenant("community"));
    expect(await getLlmCredentials("t1")).toMatchObject({ trial: true, maxQueue: 6, maxWaitSec: 90 });
  });

  it("is the env model for a tier with no pick, and for a call with no workspace", async () => {
    db.platformTierModel.findMany.mockResolvedValue([{ tier: "growth", platformModel: model() }]);
    db.tenant.findUnique.mockResolvedValue(tenant("community"));
    expect(await getLlmCredentials("t1")).toMatchObject({ source: "env", model: "qwen-3.8-27b", apiKey: "env-key" });
    expect((await getLlmCredentials(null))?.model).toBe("qwen-3.8-27b");
  });

  it("never replaces a workspace's own key", async () => {
    db.platformTierModel.findMany.mockResolvedValue([{ tier: "business", platformModel: model() }]);
    db.tenant.findUnique.mockResolvedValue(tenant("business", { llmProvider: "anthropic", llmKeyEnc: "own", llmModel: "claude-sonnet-4-6" }));
    expect(await getLlmCredentials("t1")).toMatchObject({ source: "tenant", model: "claude-sonnet-4-6", apiKey: "key:own" });
  });

  it("falls back to env when a stored key no longer decrypts or the table cannot be read", async () => {
    db.platformTierModel.findMany.mockResolvedValue([{ tier: "growth", platformModel: model({ keyEnc: "bad" }) }]);
    expect(await platformModelForTier("growth")).toBeNull();
    clearPlatformModelCache();
    db.platformTierModel.findMany.mockRejectedValue(new Error("no table"));
    expect(await platformModelForTier("growth")).toBeNull();
  });

  it("reads the table once per cache window, and again after a save clears it", async () => {
    db.platformTierModel.findMany.mockResolvedValue([{ tier: "growth", platformModel: model() }]);
    await platformModelForTier("growth");
    await platformModelForTier("community");
    expect(db.platformTierModel.findMany).toHaveBeenCalledTimes(1);
    clearPlatformModelCache();
    await platformModelForTier("growth");
    expect(db.platformTierModel.findMany).toHaveBeenCalledTimes(2);
  });
});
