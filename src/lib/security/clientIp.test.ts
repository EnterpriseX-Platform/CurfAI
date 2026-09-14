import { afterEach, describe, expect, it } from "vitest";
import { clientIp } from "./clientIp";

function req(headers: Record<string, string>) {
  return { headers: new Headers(headers) };
}

describe("clientIp", () => {
  afterEach(() => { delete process.env.CURF_TRUSTED_PROXY_HOPS; });

  it("keys on the hop the trusted proxy appended, not the client-supplied first entry", () => {
    expect(clientIp(req({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("a spoofed single-entry header still yields that entry when there is no proxy", () => {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("honours CURF_TRUSTED_PROXY_HOPS for a CDN in front of the ingress", () => {
    process.env.CURF_TRUSTED_PROXY_HOPS = "2";
    expect(clientIp(req({ "x-forwarded-for": "9.9.9.9, 203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
  });

  it("falls back to X-Real-IP, then to a shared bucket", () => {
    expect(clientIp(req({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientIp(req({}))).toBe("unknown");
  });
});
