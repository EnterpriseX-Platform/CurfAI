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

  it("meters a platform model at the rate a platform admin set, over the list price", () => {
    // kimi-k2.6 lists at $0.95 in / $4 out; the admin's rate wins.
    expect(computeMicroCostMetered({ provider: "openai-compatible", model: "kimi-k2.6", ...call }, { inputPer1M: 0.1, outputPer1M: 0.4 })).toBe(500_000);
    // A self-hosted model with no list price, priced by the admin, is not charged at the dearest rate.
    expect(computeMicroCostMetered({ provider: "openai-compatible", model: "qwen-3.8-27b", ...call }, { inputPer1M: 0.05, outputPer1M: 0.2 })).toBe(250_000);
  });
});

describe("formatMicroUsd small amounts", () => {
  it("writes a sub-cent amount in cents without a dollar sign", async () => {
    const { formatMicroUsd } = await import("./pricing");
    expect(formatMicroUsd(396)).toBe("0.0396¢");
    expect(formatMicroUsd(5_000)).toBe("0.50¢");
    expect(formatMicroUsd(96_000)).toBe("$0.096");
  });
});
