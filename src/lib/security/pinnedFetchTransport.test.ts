/**
 * The mechanics of the pinned connection (headers, body, status, redirects, size cap, timeout) against a local
 * server. The address guard is switched off here, and only here, because a local server is by definition not
 * public; its refusals are tested against the real guard in pinnedFetch.test.ts.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/security/ssrfGuard", () => ({ isBlockedAddress: () => false }));

import { pinnedPublicFetch } from "./pinnedFetch";

let server: http.Server;
let base: string;
const seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url === "/json") return void res.writeHead(200, { "content-type": "application/json", "x-thing": "a" }).end('{"ok":true}');
      if (req.url === "/redirect") return void res.writeHead(302, { location: "http://169.254.169.254/" }).end();
      if (req.url === "/none") return void res.writeHead(204).end();
      if (req.url === "/problem") return void res.writeHead(422, { "content-type": "application/problem+json" }).end('{"detail":"no"}');
      if (req.url === "/big") return void res.writeHead(200).end(Buffer.alloc(5000, 97));
      if (req.url === "/slow") return; // never answers
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }));

describe("pinnedPublicFetch transport", () => {
  it("returns a standard Response: status, headers and a body that parses", async () => {
    const res = await pinnedPublicFetch(`${base}/json`);
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.headers.get("x-thing")).toBe("a");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("sends the method, headers and body, with the right length", async () => {
    seen.length = 0;
    await pinnedPublicFetch(`${base}/json`, { method: "POST", headers: { Authorization: "Bearer x", "Content-Type": "application/json" }, body: '{"a":"ไทย"}' });
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers.authorization).toBe("Bearer x");
    expect(seen[0].body).toBe('{"a":"ไทย"}');
    expect(Number(seen[0].headers["content-length"])).toBe(Buffer.byteLength('{"a":"ไทย"}'));
  });

  it("does not follow a redirect: the caller sees the 3xx", async () => {
    seen.length = 0;
    const res = await pinnedPublicFetch(`${base}/redirect`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://169.254.169.254/");
    expect(seen).toHaveLength(1);
  });

  it("handles an answer with no body, and an error answer", async () => {
    expect((await pinnedPublicFetch(`${base}/none`)).status).toBe(204);
    const problem = await pinnedPublicFetch(`${base}/problem`);
    expect(problem.status).toBe(422);
    expect(await problem.json()).toEqual({ detail: "no" });
  });

  it("refuses an answer bigger than the cap instead of holding it in memory", async () => {
    await expect(pinnedPublicFetch(`${base}/big`, { maxBytes: 1000 })).rejects.toThrow(/larger than/);
    expect((await pinnedPublicFetch(`${base}/big`, { maxBytes: 10_000 })).status).toBe(200);
  });

  it("gives up when the signal fires, as a TimeoutError, so callers can tell a slow engine from a down one", async () => {
    await expect(pinnedPublicFetch(`${base}/slow`, { signal: AbortSignal.timeout(150) })).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("does not start when the signal has already fired", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(pinnedPublicFetch(`${base}/json`, { signal: controller.signal })).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("reports a connection that cannot be made as an error", async () => {
    await expect(pinnedPublicFetch("http://127.0.0.1:1/")).rejects.toThrow();
  });
});
