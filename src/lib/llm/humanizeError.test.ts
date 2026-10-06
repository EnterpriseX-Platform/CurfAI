import { describe, it, expect } from "vitest";
import { humanizeLlmError } from "./humanizeError";

describe("humanizeLlmError — never leaks raw provider payloads", () => {
  it("says the provider account is out of credit — not a rate limit — for Kimi's 429 'insufficient balance'", () => {
    // What prod logged on 2026-09-30, account ids shortened.
    const raw =
      'HTTP 429: {"error":{"message":"Your account org-7e131fc8... <ak-fam5...> is suspended due to insufficient balance, please recharge your account or check your plan and billing details","type":"exceeded_current_quota_error"}}';
    const { message, canSwitchModel } = humanizeLlmError(raw);
    expect(message).not.toContain("org-7e131fc8");
    expect(message).not.toContain("ak-fam5");
    expect(message).not.toContain("exceeded_current_quota_error");
    expect(message).toContain("run out of credit");
    expect(message).toContain("ไม่มียอดเงินคงเหลือ");
    // Waiting is the wrong advice, and so is another model on the same account.
    expect(message.toLowerCase()).not.toContain("rate limit");
    expect(message).not.toContain("wait a moment");
    expect(canSwitchModel).toBe(false);
    // The same from OpenAI and Anthropic.
    expect(humanizeLlmError('HTTP 429: {"error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}').message)
      .toContain("run out of credit");
    expect(humanizeLlmError("400 Your credit balance is too low to access the Anthropic API.").message).toContain("run out of credit");
  });

  it("still reads a real 429 as a rate limit to wait out", () => {
    const { message } = humanizeLlmError('HTTP 429: {"error":{"message":"Rate limit reached for requests, please try again in 20s","type":"rate_limit_reached_error"}}');
    expect(message.toLowerCase()).toContain("rate limit");
    expect(message).toContain("wait a moment");
    expect(message).not.toContain("rate_limit_reached_error");
  });

  it("flags not-configured providers distinctly", () => {
    const { message, notConfigured } = humanizeLlmError("LLM provider not configured for this tenant");
    expect(notConfigured).toBe(true);
    expect(message).toContain("Tenant Settings");
  });

  it("maps auth errors without echoing the raw key/token", () => {
    const { message } = humanizeLlmError("401 Unauthorized: invalid_api_key sk-abc123");
    expect(message).not.toContain("sk-abc123");
    expect(message).toContain("Tenant Settings");
  });

  it("never returns the raw string verbatim for an unrecognized error", () => {
    const raw = "some_internal_vendor_error_code_9912";
    const { message } = humanizeLlmError(raw);
    expect(message).not.toContain(raw);
  });

  it("handles an empty/undefined error as a generic failure", () => {
    const { message } = humanizeLlmError(undefined);
    expect(message.length).toBeGreaterThan(0);
  });
});

describe("humanizeLlmError — canSwitchModel (drives the Master Builder 'switch sub-model and retry' UI)", () => {
  it("flags reasoning-budget exhaustion as switchable — the exact failure that motivated this UI", () => {
    expect(humanizeLlmError("REASONING_BUDGET_EXHAUSTED").canSwitchModel).toBe(true);
  });

  it("flags a request timeout as switchable — some sub-models are just slower", () => {
    expect(humanizeLlmError("Request timed out after 91s").canSwitchModel).toBe(true);
  });

  it("flags a temperature-incompatible model as switchable — a per-model quirk, not a provider one", () => {
    expect(humanizeLlmError("temperature is not supported for this model").canSwitchModel).toBe(true);
  });

  it("flags an empty/blocked response as switchable", () => {
    expect(humanizeLlmError(undefined).canSwitchModel).toBe(true);
  });

  it("flags an unclassified error as switchable — can't rule out it's model-specific", () => {
    expect(humanizeLlmError("some_internal_vendor_error_code_9912").canSwitchModel).toBe(true);
  });

  it("does NOT offer a model switch when no provider is configured at all", () => {
    expect(humanizeLlmError("LLM provider not configured for this tenant").canSwitchModel).toBe(false);
  });

  it("does NOT offer a model switch for an invalid/expired API key — the key is the problem, not the model", () => {
    expect(humanizeLlmError("401 Unauthorized: invalid_api_key sk-abc123").canSwitchModel).toBe(false);
  });

  it("does NOT offer a model switch for a rate limit — provider-wide throttling, not per-model", () => {
    expect(humanizeLlmError("rate limit exceeded 429").canSwitchModel).toBe(false);
  });

  it("does NOT offer a model switch for a network/connection failure — switching models still hits the same network path", () => {
    expect(humanizeLlmError("fetch failed: ECONNREFUSED").canSwitchModel).toBe(false);
  });
});
