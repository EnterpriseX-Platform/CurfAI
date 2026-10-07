/**
 * The admin proxy route: who may call it, what it refuses before the engine is asked, what it sends, and how the
 * engine's answers come back. The allow-list itself is tested in lib/engine/adminProxy.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const ID = "3f2b8c1e-9d4a-4e7b-a1c2-5d6e7f8a9b0c";
const h = vi.hoisted(() => ({
  user: null as any,
  call: vi.fn(),
  audit: vi.fn(),
  ctx: { target: { baseUrl: "http://e", source: "platform" }, viewer: { id: "a1", isAdmin: true, roles: [] }, tenantId: "t1", dataSource: { id: "ds1", name: "E" } } as any,
}));

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(async () => (h.user?.role === "admin" ? h.user : NextResponse.json({ error: "Forbidden" }, { status: 403 }))),
}));
vi.mock("@/lib/audit", () => ({ recordAudit: (...a: unknown[]) => h.audit(...a) }));
vi.mock("@/lib/engine/dataSource", () => ({
  engineContextFor: vi.fn(async (_u: any, id: string) => (id === "ds1" ? h.ctx : NextResponse.json({ error: "Not found" }, { status: 404 }))),
}));
vi.mock("@/lib/engine/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/engine/client")>("@/lib/engine/client");
  return { ...actual, engineCall: (...a: unknown[]) => h.call(...a) };
});

import { DELETE, GET, POST, PUT } from "./[...path]/route";

const req = (method: string, path: string, query = "dataSourceId=ds1", body?: string) =>
  new NextRequest(`http://curf.test/api/engine/admin/${path}?${query}`, { method, body, headers: body ? { "content-type": "application/json" } : undefined });
const ctxFor = (path: string) => ({ params: { path: path.split("/") } });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const run = (handler: typeof GET, method: string, path: string, query?: string, body?: string) => handler(req(method, path, query, body), ctxFor(path));

beforeEach(() => {
  h.user = { id: "a1", role: "admin", tenantId: "t1" };
  h.call.mockReset().mockResolvedValue(json(200, { ok: true }));
  h.audit.mockReset();
});

describe("who and what", () => {
  it("is for admins only, and asks the engine nothing otherwise", async () => {
    h.user = { id: "u1", role: "viewer", tenantId: "t1" };
    expect((await run(GET, "GET", "views")).status).toBe(403);
    h.user = { id: "d1", role: "developer", tenantId: "t1" };
    expect((await run(GET, "GET", "views")).status).toBe(403);
    expect(h.call).not.toHaveBeenCalled();
  });

  it("needs a data source, and one the admin may use", async () => {
    expect((await run(GET, "GET", "views", "")).status).toBe(400);
    expect((await run(GET, "GET", "views", "dataSourceId=other")).status).toBe(404);
    expect(h.call).not.toHaveBeenCalled();
  });

  it("refuses a path or method that is not in the allow-list before the engine is called", async () => {
    expect((await run(GET, "GET", "reports")).status).toBe(404);
    expect((await run(POST, "POST", "queries/execute")).status).toBe(404);
    expect((await run(GET, "GET", "views/..%2fme")).status).toBe(404);
    expect((await run(DELETE, "DELETE", "views")).status).toBe(405);
    expect((await run(PUT, "PUT", "audit-events")).status).toBe(405);
    expect(h.call).not.toHaveBeenCalled();
  });
});

describe("what is sent to the engine", () => {
  it("a read: the path and only the allowed query parameters, as the admin, safe to repeat", async () => {
    await run(GET, "GET", "views", "dataSourceId=ds1&page=1&size=20&sql=drop&admin=1");
    expect(h.call).toHaveBeenCalledWith(expect.objectContaining({
      method: "GET", path: "/views?page=1&size=20", idempotent: true, tenantId: "t1", viewer: h.ctx.viewer, target: h.ctx.target,
    }));
    expect(h.call.mock.calls[0][0].body).toBeUndefined();
  });

  it("a change: the JSON body, and never repeated", async () => {
    await run(POST, "POST", `connections/${ID}/test`, "dataSourceId=ds1", "{}");
    await run(PUT, "PUT", `views/${ID}`, "dataSourceId=ds1", JSON.stringify({ name: "n", version: 3 }));
    expect(h.call.mock.calls[1][0]).toMatchObject({ method: "PUT", path: `/views/${ID}`, body: { name: "n", version: 3 }, idempotent: false });
  });

  it("rejects a body that is not JSON, and one that is too large, before calling the engine", async () => {
    expect((await run(POST, "POST", "views", "dataSourceId=ds1", "not json")).status).toBe(400);
    const big = JSON.stringify({ sql: "x".repeat(1024 * 1024 + 1) });
    expect((await run(POST, "POST", "views", "dataSourceId=ds1", big)).status).toBe(413);
    expect(h.call).not.toHaveBeenCalled();
  });

  it("an empty body is allowed (publish, test)", async () => {
    expect((await run(POST, "POST", `views/${ID}/publish`)).status).toBe(200);
    expect(h.call.mock.calls[0][0].body).toBeUndefined();
  });
});

describe("what comes back", () => {
  it("passes on what the engine says, with its status, including its explanation of a refusal", async () => {
    h.call.mockResolvedValue(json(422, { detail: "Request validation failed", errors: [{ field: "name", message: "taken" }], code: "CURF_INVALID_INPUT" }));
    const res = await run(POST, "POST", "views", "dataSourceId=ds1", "{}");
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ errors: [{ field: "name", message: "taken" }] });
    for (const status of [403, 404, 409]) {
      h.call.mockResolvedValue(json(status, { detail: "x" }));
      expect((await run(GET, "GET", `views/${ID}`)).status).toBe(status);
    }
  });

  it("a 204 stays empty", async () => {
    h.call.mockResolvedValue(new Response(null, { status: 204 }));
    const res = await run(DELETE, "DELETE", `views/${ID}`);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("the engine rejecting Curf's own token, or failing, is a bad gateway and not the admin's error", async () => {
    h.call.mockResolvedValue(json(401, { detail: "bad token" }));
    const unauth = await run(GET, "GET", "views");
    expect(unauth.status).toBe(502);
    expect((await unauth.json()).error).toMatch(/identity token/);
    h.call.mockResolvedValue(json(500, { detail: "boom" }));
    expect((await run(GET, "GET", "views")).status).toBe(502);
    h.call.mockResolvedValue(json(502, { detail: "The database could not be reached" }));
    expect((await run(POST, "POST", `connections/${ID}/introspect`)).status).toBe(502);
  });

  it("an engine that cannot be reached is a 502 with the reason", async () => {
    h.call.mockRejectedValue(new Error("The engine could not be reached."));
    const res = await run(GET, "GET", "views");
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("The engine could not be reached.");
  });
});

describe("the audit trail", () => {
  it("records a change that went through: who, which engine connection, the method and path, never the body", async () => {
    h.call.mockResolvedValue(json(201, { id: ID }));
    await run(POST, "POST", "connections", "dataSourceId=ds1", JSON.stringify({ password: "hunter2-secret", host: "db" }));
    expect(h.audit).toHaveBeenCalledTimes(1);
    const entry = h.audit.mock.calls[0][0];
    expect(entry).toMatchObject({ kind: "engine.admin", target: "ds1", meta: { method: "POST", path: "/connections" } });
    expect(JSON.stringify(entry)).not.toContain("hunter2");
  });

  it("does not record a read, or a change the engine refused", async () => {
    await run(GET, "GET", "views");
    h.call.mockResolvedValue(json(422, {}));
    await run(POST, "POST", "views", "dataSourceId=ds1", "{}");
    h.call.mockResolvedValue(json(409, {}));
    await run(PUT, "PUT", `views/${ID}`, "dataSourceId=ds1", "{}");
    expect(h.audit).not.toHaveBeenCalled();
  });
});
