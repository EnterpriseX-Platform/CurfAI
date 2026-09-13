import { describe, it, expect } from "vitest";
import { joinRestUrl } from "./restUrl";

describe("joinRestUrl", () => {
  it("returns baseUrl verbatim for an empty or root path", () => {
    expect(joinRestUrl("https://api.example.com/v1", "")).toBe("https://api.example.com/v1");
    expect(joinRestUrl("https://api.example.com/v1", "/")).toBe("https://api.example.com/v1");
  });

  it("appends a relative path to the base, preserving the base's own path", () => {
    expect(joinRestUrl("https://api.example.com/v1", "orders")).toBe("https://api.example.com/v1/orders");
    expect(joinRestUrl("https://api.example.com/v1", "/orders")).toBe("https://api.example.com/v1/orders");
    expect(joinRestUrl("https://api.example.com/v1/", "orders")).toBe("https://api.example.com/v1/orders");
  });

  it("allows an absolute path on the same origin as baseUrl (e.g. a pagination link)", () => {
    expect(joinRestUrl("https://api.example.com/v1", "https://api.example.com/v2/orders")).toBe(
      "https://api.example.com/v2/orders",
    );
  });

  it("rejects an absolute path on a different origin — the credential-exfiltration case", () => {
    expect(() => joinRestUrl("https://api.example.com/v1", "https://attacker.example/collect")).toThrow(
      /different host/i,
    );
  });

  it("rejects a different scheme on the same host", () => {
    expect(() => joinRestUrl("https://api.example.com", "http://api.example.com/orders")).toThrow(/different host/i);
  });

  it("rejects a different port on the same host", () => {
    expect(() => joinRestUrl("https://api.example.com", "https://api.example.com:8443/orders")).toThrow(
      /different host/i,
    );
  });
});
