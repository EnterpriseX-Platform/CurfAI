import { describe, expect, it, vi } from "vitest";
import { computeMicroCost, computeMicroCostMetered } from "./pricing";

const call = { inputTokens: 1_000_000, outputTokens: 1_000_000 };

describe("computeMicroCost", () => {
  it("prices a known model from the table", () => {
    expect(computeMicroCost({ provider: "anthropic", model: "claude-sonnet-4-6", ...call })).toBe(18_000_000);
  });

  it("matches a dated variant to its family", () => {
    expect(computeMicroCost({ provider: "openai", model: "gpt-4o-2024-11-20", ...call })).toBe(12_500_000);
  });

  it("returns null for a model it has no price for — reported as unknown, never guessed", () => {
    expect(computeMicroCost({ provider: "openai-compatible", model: "llama-3-70b", ...call })).toBeNull();
  });
});

describe("computeMicroCostMetered", () => {
  it("uses the exact price when known", () => {
    expect(computeMicroCostMetered({ provider: "anthropic", model: "claude-haiku-4-5", ...call })).toBe(4_800_000);
  });

  it("charges an unknown model at the provider's dearest known rate so it is never free", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Anthropic's dearest is Opus: $15 in + $75 out per 1M.
    expect(computeMicroCostMetered({ provider: "anthropic", model: "claude-next-1", ...call })).toBe(90_000_000);
    // A provider with no table at all falls back to Sonnet's rate.
    expect(computeMicroCostMetered({ provider: "openai-compatible", model: "llama-3-70b", ...call })).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
