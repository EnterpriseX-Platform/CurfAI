import { describe, it, expect } from "vitest";
import { humanizeLlmError } from "./humanizeError";

describe("humanizeLlmError — never leaks raw provider payloads", () => {
  it("maps a raw Kimi/OpenAI-compatible 429 blob to a friendly rate-limit message", () => {
    const raw =
      'HTTP 429: {"error":{"message":"Your account org-7e131fc8... is suspended due to insufficient balance, please recharge.","type":"insufficient_balance"}}';
    const { message } = humanizeLlmError(raw);
    expect(message).not.toContain("org-7e131fc8");
    expect(message).not.toContain("insufficient_balance");
    expect(message.toLowerCase()).toContain("rate limit");
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
