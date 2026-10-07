import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type { EngineFetch } from "./client";
import { checkEngine } from "./status";

const saved = { key: process.env.CURF_ENGINE_SIGNING_KEY, iss: process.env.CURF_ENGINE_ISSUER, auth: process.env.NEXTAUTH_URL };
beforeEach(() => {
  process.env.CURF_ENGINE_SIGNING_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.CURF_ENGINE_ISSUER = "https://curf.example";
  process.env.NEXTAUTH_URL = "https://curf.example";
});
afterEach(() => {
  for (const [name, value] of [["CURF_ENGINE_SIGNING_KEY", saved.key], ["CURF_ENGINE_ISSUER", saved.iss], ["NEXTAUTH_URL", saved.auth]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const me = (over: object = {}) => ({ tenantId: "t1", subject: "u1", username: "u1", roles: ["curf-viewer"], groups: [], attributes: { agency_code: ["A001"] }, permissions: ["view:query"], ...over });
const ctx = (fetchImpl: EngineFetch, source: "platform" | "workspace" = "platform") => ({ target: { baseUrl: "http://engine.internal", source }, viewer: { id: "u1", isAdmin: false, roles: [] as string[] }, tenantId: "t1", fetchImpl });
const engine = (opts: { me?: () => Response; views?: () => Response }): EngineFetch => async (url) => {
  const path = new URL(url).pathname.replace("/engine/v1", "");
  if (path === "/me") return opts.me ? opts.me() : json(200, me());
  if (path === "/views") return opts.views ? opts.views() : json(200, [{ id: "v1", name: "V", version: 1, columns: [] }]);
  return json(404, {});
};

describe("checkEngine", () => {
  it("everything right: reachable, accepts Curf's token, the right workspace, and how many views", async () => {
    const s = await checkEngine(ctx(engine({})));
    expect(s).toMatchObject({ ok: true, reachable: true, acceptsIdentity: true, workspaceMatches: true, views: 1, source: "platform" });
    expect(s.identity).toEqual({ username: "u1", tenantId: "t1", roles: ["curf-viewer"], permissions: ["view:query"], attributes: { agency_code: ["A001"] } });
    expect(s.problem).toBeUndefined();
    expect(s.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("an unreachable engine says so, and what to check, by where the URL came from", async () => {
    const down: EngineFetch = async () => { throw new Error("connect ECONNREFUSED"); };
    const platform = await checkEngine(ctx(down, "platform"));
    expect(platform).toMatchObject({ ok: false, reachable: false, acceptsIdentity: false });
    expect(platform.hint).toMatch(/CURF_ENGINE_URL/);
    expect((await checkEngine(ctx(down, "workspace"))).hint).toMatch(/URL on this connection/);
  });

  it("a 401 says which issuer and key set the engine has to trust", async () => {
    const s = await checkEngine(ctx(engine({ me: () => json(401, {}) })));
    expect(s).toMatchObject({ ok: false, reachable: true, acceptsIdentity: false });
    expect(s.hint).toContain("https://curf.example");
    expect(s.hint).toContain("https://curf.example/api/engine/jwks");
  });

  it("an engine that files this person under another workspace is called out, because everything else would seem to work", async () => {
    const s = await checkEngine(ctx(engine({ me: () => json(200, me({ tenantId: "default" })) })));
    expect(s).toMatchObject({ ok: false, acceptsIdentity: true, workspaceMatches: false });
    expect(s.problem).toMatch(/different workspace/);
    expect(s.hint).toContain("CURF_ENGINE_SECURITY_CLAIMS_TENANT=tenant");
    expect(s.views).toBeUndefined(); // it does not go on to list another workspace's views
  });

  it("no views yet: fine, but it says what to do", async () => {
    const s = await checkEngine(ctx(engine({ views: () => json(200, []) })));
    expect(s).toMatchObject({ ok: true, views: 0 });
    expect(s.hint).toMatch(/publish/i);
  });

  it("an engine that cannot list views is not ok, and says why", async () => {
    const s = await checkEngine(ctx(engine({ views: () => json(500, {}) })));
    expect(s.ok).toBe(false);
    expect(s.problem).toMatch(/500/);
    expect(s.identity?.tenantId).toBe("t1");
  });

  it("something that is not a Curf engine is not mistaken for one", async () => {
    const s = await checkEngine(ctx(engine({ me: () => json(200, { hello: "world" }) })));
    expect(s).toMatchObject({ ok: false, reachable: true });
    expect(s.problem).toMatch(/not like a Curf engine/);
  });

  it("never returns the token", async () => {
    let token = "";
    const seen: EngineFetch = async (url, init) => { token = init.headers.Authorization.replace("Bearer ", ""); return json(200, me()); };
    const s = await checkEngine(ctx(seen));
    expect(token.length).toBeGreaterThan(100);
    expect(JSON.stringify(s)).not.toContain(token);
  });
});
