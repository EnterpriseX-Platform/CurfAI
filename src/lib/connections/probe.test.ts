/**
 * SEC-8 (audit 2026-09-27): the REST probe used a local joinUrl that honoured
 * an absolute `path` verbatim, so a caller-chosen host received the fetch with
 * the connection's decrypted headers (Authorization: Bearer …) attached. It
 * now pins the path to the connection's own origin (joinRestUrl) and never
 * reaches guardedFetch for a cross-origin path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const ssrf = vi.hoisted(() => ({ guardedFetch: vi.fn() }));
vi.mock("@/lib/security/ssrfGuard", () => ({ guardedFetch: ssrf.guardedFetch }));

import { probeRestDataSource } from "./probe";

const conn = JSON.stringify({ baseUrl: "https://api.example.com/v1", headers: { Authorization: "Bearer secret" } });

beforeEach(() => vi.clearAllMocks());

describe("probeRestDataSource — the path can't send credentials off-origin", () => {
  it("refuses an absolute path on another host without fetching", async () => {
    const r = await probeRestDataSource(conn, { path: "https://attacker.example/collect" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/different host|refusing/i);
    expect(ssrf.guardedFetch).not.toHaveBeenCalled();
  });

  it("keeps a relative path on the connection's own origin", async () => {
    ssrf.guardedFetch.mockResolvedValue(new Response(JSON.stringify([{ id: 1 }]), { status: 200, headers: { "content-type": "application/json" } }));
    await probeRestDataSource(conn, { path: "/orders" });
    expect(ssrf.guardedFetch).toHaveBeenCalledTimes(1);
    expect(String(ssrf.guardedFetch.mock.calls[0][0])).toBe("https://api.example.com/v1/orders");
  });
});
