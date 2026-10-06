import { describe, it, expect, vi } from "vitest";
import type { Page } from "puppeteer";
import { setSessionCookie } from "./puppeteerAuth";

function fakePage() {
  const setCookie = vi.fn().mockResolvedValue(undefined);
  return { setCookie } as unknown as Page & { setCookie: ReturnType<typeof vi.fn> };
}

describe("setSessionCookie", () => {
  it("marks __Secure- prefixed cookies secure+httpOnly+lax when the target is https — the live 500 this guards", async () => {
    // Live case: prod serves over HTTPS, so NextAuth issues
    // __Secure-next-auth.session-token. Chrome's CDP rejects
    // Network.setCookies for a __Secure- cookie unless secure:true is set —
    // that rejection is what surfaced as the bare "Invalid cookie fields"
    // 500 on every browser-session PDF export.
    const page = fakePage();
    await setSessionCookie(page, "https://curfai.centerapp.io", "__Secure-next-auth.session-token=abc%20def");

    expect(page.setCookie).toHaveBeenCalledWith({
      name: "__Secure-next-auth.session-token",
      value: "abc def",
      domain: "curfai.centerapp.io",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    });
  });

  it("marks the unprefixed cookie non-secure for plain-http local dev", async () => {
    const page = fakePage();
    await setSessionCookie(page, "http://localhost:3100", "next-auth.session-token=abc");

    expect(page.setCookie).toHaveBeenCalledWith({
      name: "next-auth.session-token",
      value: "abc",
      domain: "localhost",
      path: "/",
      secure: false,
      httpOnly: true,
      sameSite: "Lax",
    });
  });

  it("accepts a Secure cookie forwarded to a loopback internal base URL", async () => {
    const page = fakePage();
    await setSessionCookie(page, "http://127.0.0.1:3100", "__Secure-next-auth.session-token=abc");

    expect(page.setCookie).toHaveBeenCalledWith(
      expect.objectContaining({ secure: true, domain: "127.0.0.1" }),
    );
  });

  it("refuses to forward a Secure cookie to a non-loopback plain-http internal base URL instead of silently dropping it on navigation", async () => {
    // A Secure-flagged cookie is never sent back by Chrome over plain HTTP
    // to a non-loopback host, even though page.setCookie() itself would
    // succeed — that combination would export a PDF/XLSX rendered as a
    // logged-out user with no error at all. Fail loudly instead.
    const page = fakePage();
    await expect(
      setSessionCookie(page, "http://curfai.default.svc.cluster.local:3100", "__Secure-next-auth.session-token=abc"),
    ).rejects.toThrow(/insecure internal base URL/);
    expect(page.setCookie).not.toHaveBeenCalled();
  });

  it("no-ops when the cookie string has no name/value pair", async () => {
    const page = fakePage();
    await setSessionCookie(page, "https://curfai.centerapp.io", "malformed");
    expect(page.setCookie).not.toHaveBeenCalled();
  });
});
