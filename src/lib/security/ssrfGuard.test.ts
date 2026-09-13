import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { assertPublicHttpUrl, guardedFetch } from "./ssrfGuard";

describe("assertPublicHttpUrl — blocks private/reserved/metadata addresses", () => {
  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:5432/",
    "http://localhost/",
    "http://10.0.0.5/internal",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://[::1]/",
    "http://[fe80::1]/",
    "http://[fc00::1]/",
    "http://[::ffff:169.254.169.254]/",
  ])("rejects %s", async (url) => {
    await expect(assertPublicHttpUrl(url)).rejects.toThrow();
  });

  it.each([
    "file:///etc/passwd",
    "gopher://127.0.0.1:6379/",
  ])("rejects non-http(s) scheme %s", async (url) => {
    await expect(assertPublicHttpUrl(url)).rejects.toThrow();
  });

  it("accepts a plain public https URL with a literal public IP", async () => {
    await expect(assertPublicHttpUrl("https://8.8.8.8/")).resolves.toBeUndefined();
  });
});

// OWASP A01/A10:2025 — assertPublicHttpUrl() alone only checks the URL the
// caller passed in; a server that legitimately passes that check can still
// respond with a 3xx Location pointing at a blocked address, and a bare
// fetch()'s default redirect:"follow" would go there with no further check
// — a simpler, more reliable SSRF bypass than DNS rebinding. guardedFetch()
// re-validates every hop before following it.
describe("guardedFetch — re-validates every redirect hop", () => {
  const realFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  function redirectTo(location: string) {
    return { status: 302, headers: new Headers({ location }) } as Response;
  }
  function finalOk() {
    return { status: 200, headers: new Headers(), ok: true } as Response;
  }

  it("follows a redirect to another public address and returns the final response", async () => {
    fetchMock
      .mockResolvedValueOnce(redirectTo("https://8.8.4.4/final"))
      .mockResolvedValueOnce(finalOk());
    const res = await guardedFetch("https://8.8.8.8/start");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Every hop must be fetched with redirect:"manual" — never "follow".
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
    expect(fetchMock.mock.calls[1][0]).toBe("https://8.8.4.4/final");
  });

  it("rejects when a redirect points at cloud metadata, WITHOUT following it", async () => {
    fetchMock.mockResolvedValueOnce(redirectTo("http://169.254.169.254/latest/meta-data/"));
    await expect(guardedFetch("https://8.8.8.8/start")).rejects.toThrow();
    // Only the first hop should ever reach fetch() — the second hop must be
    // blocked by assertPublicHttpUrl() before a second fetch() call happens.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects when a redirect points at an internal RFC1918 address", async () => {
    fetchMock.mockResolvedValueOnce(redirectTo("http://10.0.0.5/internal-api"));
    await expect(guardedFetch("https://8.8.8.8/start")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns immediately when there's no redirect at all", async () => {
    fetchMock.mockResolvedValueOnce(finalOk());
    const res = await guardedFetch("https://8.8.8.8/start");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after too many redirects rather than looping forever", async () => {
    for (let i = 0; i < 10; i++) {
      fetchMock.mockResolvedValueOnce(redirectTo("https://8.8.8.8/hop" + i));
    }
    await expect(guardedFetch("https://8.8.8.8/start")).rejects.toThrow(/too many redirects/i);
  });
});
