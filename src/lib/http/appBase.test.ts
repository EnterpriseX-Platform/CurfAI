import { describe, it, expect, afterEach } from "vitest";
import { appBase } from "./appBase";

function req(headers: Record<string, string>, url: string): any {
  const map = new Map(Object.entries(headers));
  return { url, headers: { get: (k: string) => map.get(k) ?? null } };
}

describe("appBase", () => {
  const originalNextAuthUrl = process.env.NEXTAUTH_URL;
  afterEach(() => {
    if (originalNextAuthUrl === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = originalNextAuthUrl;
  });

  it("prefers X-Forwarded-Proto/Host over everything else", () => {
    process.env.NEXTAUTH_URL = "https://nextauth.example";
    const r = req(
      { "x-forwarded-proto": "https", "x-forwarded-host": "curfai.centerapp.io" },
      "http://localhost:3100/api/apps/x/viewers",
    );
    expect(appBase(r)).toBe("https://curfai.centerapp.io");
  });

  it("falls back to NEXTAUTH_URL when no forwarded headers are present", () => {
    process.env.NEXTAUTH_URL = "https://curfai.centerapp.io";
    const r = req({}, "http://localhost:3100/api/apps/x/viewers");
    expect(appBase(r)).toBe("https://curfai.centerapp.io");
  });

  it("falls back to the request's own origin when neither is available — the local-dev case", () => {
    delete process.env.NEXTAUTH_URL;
    const r = req({}, "http://localhost:3100/api/apps/x/viewers");
    expect(appBase(r)).toBe("http://localhost:3100");
  });

  it("never resolves to the pod-internal origin when a real deployment's proxy headers are present — the live bug this guards", () => {
    // Live case: a k8s ingress terminates TLS and forwards to the pod on
    // its internal port; naively reading the request's own URL there
    // resolves to http://localhost:3100 — unreachable from outside the
    // cluster — even though NEXTAUTH_URL and the forwarded headers both
    // correctly name the public host.
    process.env.NEXTAUTH_URL = "https://curfai.centerapp.io";
    const r = req(
      { "x-forwarded-proto": "https", "x-forwarded-host": "curfai.centerapp.io" },
      "http://localhost:3100/api/portal/auth/link",
    );
    expect(appBase(r)).not.toMatch(/localhost/);
    expect(appBase(r)).toBe("https://curfai.centerapp.io");
  });
});
