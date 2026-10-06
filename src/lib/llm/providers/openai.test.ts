/**
 * kimi-k2.7-code 400s on the `thinking` field itself, unlike the rest of
 * the Kimi family — see reasoningFieldsFor's own doc comment for the
 * live-verified evidence (Issue Log FE-ASK-05 / BE-LLM-01).
 */
import { describe, it, expect } from "vitest";
import { reasoningFieldsFor } from "./openai";

const MOONSHOT_AI = "https://api.moonshot.ai/v1";
const MOONSHOT_CN = "https://api.moonshot.cn/v1";

describe("reasoningFieldsFor", () => {
  it("sends thinking:disabled for reasoning-capable Kimi models on Moonshot", () => {
    expect(reasoningFieldsFor("openai-compatible", MOONSHOT_AI, "kimi-k3")).toEqual({ thinking: { type: "disabled" } });
    expect(reasoningFieldsFor("openai-compatible", MOONSHOT_AI, "kimi-k2.6")).toEqual({ thinking: { type: "disabled" } });
    expect(reasoningFieldsFor("openai-compatible", MOONSHOT_CN, "kimi-k3")).toEqual({ thinking: { type: "disabled" } });
  });

  it("omits the thinking field for the -code Kimi variants, which reject it", () => {
    expect(reasoningFieldsFor("openai-compatible", MOONSHOT_AI, "kimi-k2.7-code")).toEqual({});
    expect(reasoningFieldsFor("openai-compatible", MOONSHOT_AI, "kimi-k2.7-code-highspeed")).toEqual({});
    expect(reasoningFieldsFor("openai-compatible", MOONSHOT_CN, "kimi-k2.7-code")).toEqual({});
  });

  it("sends reasoning_effort:low for OpenAI o-series models", () => {
    expect(reasoningFieldsFor("openai", "https://api.openai.com/v1", "o3")).toEqual({ reasoning_effort: "low" });
    expect(reasoningFieldsFor("openai", "https://api.openai.com/v1", "o3-mini")).toEqual({ reasoning_effort: "low" });
  });

  it("sends no reasoning field for hosts/models without a switch", () => {
    expect(reasoningFieldsFor("openai", "https://api.openai.com/v1", "gpt-4o-mini")).toEqual({});
    expect(reasoningFieldsFor("openai-compatible", "https://api.deepseek.com/v1", "deepseek-chat")).toEqual({});
    // Kimi models are only known to accept `thinking` when hosted on Moonshot itself.
    expect(reasoningFieldsFor("openai-compatible", "https://openrouter.ai/api/v1", "kimi-k3")).toEqual({});
  });
});
