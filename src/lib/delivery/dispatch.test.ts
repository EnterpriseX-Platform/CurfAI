/**
 * parseDeliveryConfig — a schedule created from the Schedules UI stores
 * recipients but no deliveryConfigJson. That case used to default to
 * kind:"log", so "รายงาน HR ประจำเช้า" ran green every morning and never
 * emailed anyone. Recipients present → email.
 */
import { describe, it, expect } from "vitest";
import { parseDeliveryConfig } from "./dispatch";

describe("parseDeliveryConfig channel defaults", () => {
  it("defaults to email when recipients exist and no config JSON is stored", () => {
    const c = parseDeliveryConfig(null, ["hr@example.com"]);
    expect(c.kind).toBe("email");
    expect(c.recipients).toEqual(["hr@example.com"]);
  });

  it("still defaults to log when there is nothing to email", () => {
    expect(parseDeliveryConfig(null, []).kind).toBe("log");
    expect(parseDeliveryConfig(undefined).kind).toBe("log");
  });

  it("an explicit kind in the config always wins", () => {
    const c = parseDeliveryConfig(JSON.stringify({ kind: "slack", slackWebhook: "https://x" }), ["hr@example.com"]);
    expect(c.kind).toBe("slack");
  });

  it("config present but kind invalid → email when recipients exist", () => {
    const c = parseDeliveryConfig(JSON.stringify({ subject: "hi" }), ["hr@example.com"]);
    expect(c.kind).toBe("email");
  });

  it("malformed JSON falls back the same way", () => {
    expect(parseDeliveryConfig("{oops", ["hr@example.com"]).kind).toBe("email");
    expect(parseDeliveryConfig("{oops", []).kind).toBe("log");
  });
});
