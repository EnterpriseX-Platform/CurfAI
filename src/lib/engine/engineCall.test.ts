/**
 * engineCall is the one door to an engine, so the rules about which transport a URL gets, when a request is
 * retried and what a failure says are tested here, once, for every feature that uses it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { ENGINE_MAX_RESPONSE_BYTES, engineCall, engineJson, engineStatusError, runEngineQuery, type EngineFetch } from "./client";

const viewer = { id: "u1", isAdmin: false, roles: [] as string[] };
const saved = { key: process.env.CURF_ENGINE_SIGNING_KEY, iss: process.env.CURF_ENGINE_ISSUER, hosts: process.env.CURF_ENGINE_ALLOWED_HOSTS };
beforeEach(() => {
  process.env.CURF_ENGINE_SIGNING_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.CURF_ENGINE_ISSUER = "https://curf.example";
  delete process.env.CURF_ENGINE_ALLOWED_HOSTS;
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, value] of [["CURF_ENGINE_SIGNING_KEY", saved.key], ["CURF_ENGINE_ISSUER", saved.iss], ["CURF_ENGINE_ALLOWED_HOSTS", saved.hosts]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const reply = (status: number, headers: Record<string, string> = {}, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers });
const platform = { baseUrl: "http://engine.internal:8080", source: "platform" as const };
const workspace = (baseUrl: string) => ({ baseUrl, source: "workspace" as const });

describe("which transport a URL gets", () => {
  it("a workspace's URL on a private address is refused before anything is sent, and the plain fetch is never used", async () => {
    const plain = vi.fn(async () => reply(200));
    vi.stubGlobal("fetch", plain);
    for (const baseUrl of ["http://127.0.0.1:8080", "http://169.254.169.254", "http://10.0.0.5", "http://[::1]:8080", "http://localhost:8080"]) {
      await expect(engineCall({ target: workspace(baseUrl), viewer, tenantId: "t1", path: "/me" }), baseUrl).rejects.toThrow(/not allowed/);
    }
    expect(plain).not.toHaveBeenCalled();
  });

  it("a workspace's URL with credentials or a strange scheme is refused outright", async () => {
    await expect(engineCall({ target: workspace("http://u:p@93.184.216.34"), viewer, tenantId: "t1", path: "/me" })).rejects.toThrow(/credentials/);
    await expect(engineCall({ target: workspace("ftp://93.184.216.34"), viewer, tenantId: "t1", path: "/me" })).rejects.toThrow(/http/);
  });

  it("the platform's engine, and a host the operator listed, use the plain connection and may be private", async () => {
    const plain = vi.fn(async () => reply(200));
    vi.stubGlobal("fetch", plain);
    await engineCall({ target: platform, viewer, tenantId: "t1", path: "/me" });
    process.env.CURF_ENGINE_ALLOWED_HOSTS = "own.internal";
    await engineCall({ target: workspace("http://own.internal:8080"), viewer, tenantId: "t1", path: "/me" });
    expect(plain).toHaveBeenCalledTimes(2);
  });

  it("an untrusted workspace URL is sent over the pinned connection, not the plain one", async () => {
    const pinned: EngineFetch = vi.fn(async () => reply(200));
    const plain = vi.fn(async () => reply(200));
    vi.stubGlobal("fetch", plain);
    // fetchImpl stands in for whichever transport the policy picked; this asserts the policy by refusing a private IP above
    // and, here, that a public one is accepted by the policy (the pinned transport itself is tested in pinnedFetch.test.ts).
    await engineCall({ target: workspace("https://93.184.216.34:8443"), viewer, tenantId: "t1", path: "/me", fetchImpl: pinned });
    expect(pinned).toHaveBeenCalledTimes(1);
    expect(plain).not.toHaveBeenCalled();
  });

  it("a private address over https passes the URL rules and is stopped by the pinned connection itself, with nothing said about the address", async () => {
    const plain = vi.fn(async () => reply(200));
    vi.stubGlobal("fetch", plain);
    for (const baseUrl of ["https://127.0.0.1:8443", "https://169.254.169.254", "https://10.0.0.5", "https://[::1]:8443", "https://localhost:8443"]) {
      const err = await engineCall({ target: workspace(baseUrl), viewer, tenantId: "t1", path: "/me" }).catch((e) => e as Error);
      expect((err as Error).message, baseUrl).toBe("The engine URL is not allowed: it does not point at a public address.");
    }
    expect(plain).not.toHaveBeenCalled();
  });
});

describe("the token's audience", () => {
  const audienceSent = async (target: any) => {
    let aud: unknown;
    const capture: EngineFetch = async (_u, init) => {
      aud = JSON.parse(Buffer.from(init.headers.Authorization.split(" ")[1].split(".")[1], "base64url").toString()).aud;
      return reply(200);
    };
    await engineCall({ target, viewer, tenantId: "t1", path: "/me", fetchImpl: capture });
    return aud;
  };

  it("is the engine's own address by default, so a token taken from one engine is of no use at another that checks it", async () => {
    expect(await audienceSent({ baseUrl: "https://e1.example:8443", source: "workspace" })).toBe("https://e1.example:8443");
    expect(await audienceSent({ baseUrl: "http://engine.internal:8080", source: "platform" })).toBe("http://engine.internal:8080");
  });

  it("is what the connection says, when it says one", async () => {
    expect(await audienceSent({ baseUrl: "https://e1.example", audience: "curf-engine", source: "workspace" })).toBe("curf-engine");
  });
});

describe("how much of an answer is read", () => {
  const streamOf = (bytes: number, chunk = 64 * 1024) => new ReadableStream<Uint8Array>({
    start(controller) {
      for (let sent = 0; sent < bytes; sent += chunk) controller.enqueue(new Uint8Array(Math.min(chunk, bytes - sent)).fill(32));
      controller.close();
    },
  });

  it("reads a normal answer", async () => {
    expect(await engineJson(new Response('{"a":[1,2,3]}'))).toEqual({ a: [1, 2, 3] });
  });

  it("refuses one that declares itself too big, without reading it", async () => {
    const res = new Response("x", { headers: { "content-length": String(10_000_000) } });
    await expect(engineJson(res, 1_000_000)).rejects.toThrow(/larger than Curf will read/);
  });

  it("stops reading an answer that does not declare its size once it passes the cap", async () => {
    await expect(engineJson(new Response(streamOf(5_000_000)), 1_000_000)).rejects.toThrow(/larger than Curf will read/);
  });

  it("a query's answer over the cap fails that query with a clear reason", async () => {
    const huge: EngineFetch = async () => new Response(streamOf(ENGINE_MAX_RESPONSE_BYTES + 1024 * 1024), { status: 200 });
    await expect(runEngineQuery({ target: platform, viewer, tenantId: "t1", query: { viewId: "v" }, params: {}, fetchImpl: huge })).rejects.toThrow(/larger than Curf will read/);
  });
});

describe("the request", () => {
  it("is signed for this person and workspace, a GET carries no body or content type, and goes under /engine/v1", async () => {
    const seen: Array<{ url: string; init: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => { seen.push({ url, init }); return reply(200); }));
    await engineCall({ target: platform, viewer, tenantId: "t9", path: "/views" });
    expect(seen[0].url).toBe("http://engine.internal:8080/engine/v1/views");
    expect(seen[0].init.method).toBe("GET");
    expect(seen[0].init.body).toBeUndefined();
    expect(seen[0].init.headers["Content-Type"]).toBeUndefined();
    const claims = JSON.parse(Buffer.from(seen[0].init.headers.Authorization.split(".")[1], "base64url").toString());
    expect(claims).toMatchObject({ sub: "u1", tenant: "t9" });
  });

  it("a POST sends its body as JSON", async () => {
    const plain = vi.fn(async () => reply(201));
    vi.stubGlobal("fetch", plain);
    await engineCall({ target: platform, viewer, tenantId: "t1", path: "/views", method: "POST", body: { name: "x" } });
    const init = (plain.mock.calls[0] as unknown as [string, any])[1];
    expect(init.body).toBe('{"name":"x"}');
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("does not follow a redirect", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(302, { location: "http://169.254.169.254/" })));
    await expect(engineCall({ target: platform, viewer, tenantId: "t1", path: "/me" })).rejects.toThrow(/redirect/);
  });
});

describe("when the engine is busy", () => {
  it("a safe read is retried once and the second answer is used", async () => {
    const answers = [reply(429, { "retry-after": "0" }), reply(200, {}, { ok: true })];
    const plain = vi.fn(async () => answers.shift()!);
    vi.stubGlobal("fetch", plain);
    const res = await engineCall({ target: platform, viewer, tenantId: "t1", path: "/views" });
    expect(res.status).toBe(200);
    expect(plain).toHaveBeenCalledTimes(2);
    const tokens = plain.mock.calls.map((c) => (c as unknown as [string, any])[1].headers.Authorization);
    expect(tokens[0]).not.toBe(tokens[1]); // a fresh token, not a replay
  });

  it("gives up after one retry rather than hammering a struggling engine", async () => {
    const plain = vi.fn(async () => reply(503, { "retry-after": "0" }));
    vi.stubGlobal("fetch", plain);
    const res = await engineCall({ target: platform, viewer, tenantId: "t1", path: "/views" });
    expect(res.status).toBe(503);
    expect(plain).toHaveBeenCalledTimes(2);
  });

  it("a write is never retried: a second attempt could do it twice", async () => {
    const plain = vi.fn(async () => reply(503));
    vi.stubGlobal("fetch", plain);
    const res = await engineCall({ target: platform, viewer, tenantId: "t1", path: "/views", method: "POST", body: {} });
    expect(res.status).toBe(503);
    expect(plain).toHaveBeenCalledTimes(1);
  });

  it("a read-only POST (a query) can be marked safe to repeat", async () => {
    const answers = [reply(429, { "retry-after": "0" }), reply(200)];
    const plain = vi.fn(async () => answers.shift()!);
    vi.stubGlobal("fetch", plain);
    const res = await engineCall({ target: platform, viewer, tenantId: "t1", path: "/queries/execute", method: "POST", body: {}, idempotent: true });
    expect(res.status).toBe(200);
  });

  it("does not wait longer than the cap, whatever the engine asks for", async () => {
    const answers = [reply(429, { "retry-after": "600" }), reply(200)];
    vi.stubGlobal("fetch", vi.fn(async () => answers.shift()!));
    const started = Date.now();
    await engineCall({ target: platform, viewer, tenantId: "t1", path: "/views" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("failures", () => {
  it("an unreachable engine says so without the address", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connect ECONNREFUSED 10.1.2.3:8080"); }));
    await expect(engineCall({ target: platform, viewer, tenantId: "t1", path: "/me" })).rejects.toThrow("The engine could not be reached.");
  });

  it("a timeout says it timed out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error("x"), { name: "TimeoutError" }); }));
    await expect(engineCall({ target: platform, viewer, tenantId: "t1", path: "/me" })).rejects.toThrow("did not answer in time");
  });

  it("a refusal raised by the pinned connection is reported as the URL not being allowed", async () => {
    const refusing: EngineFetch = async () => { throw Object.assign(new Error('Refusing to connect to "evil.example" — resolves to private/reserved address 10.9.8.7'), { code: "ESSRF" }); };
    const err = await engineCall({ target: workspace("https://evil.example"), viewer, tenantId: "t1", path: "/me", fetchImpl: refusing }).catch((e) => e as Error);
    expect((err as Error).message).toMatch(/not allowed/);
    expect((err as Error).message).not.toContain("10.9.8.7"); // what a name resolves to inside the network is not for a viewer to read
  });
});

describe("engineStatusError", () => {
  it.each([[200, null], [401, /identity token/], [403, /does not allow/], [404, /does not exist/], [429, /busy/], [503, /not ready/], [504, /time limit/], [500, /\(500\)/]])(
    "%i", async (status, expected) => {
      const message = await engineStatusError(new Response("{}", { status: status as number }));
      if (expected === null) expect(message).toBeNull();
      else expect(message).toMatch(expected as RegExp);
    });

  it("passes on the engine's first reason for a rejected request, in the caller's words", async () => {
    const res = new Response(JSON.stringify({ errors: [{ message: "name is taken" }, { message: "second" }] }), { status: 422 });
    expect(await engineStatusError(res, "view")).toBe("The engine rejected the view: name is taken");
  });
});
