/**
 * The attribute routes: admins only, scoped to the admin's own workspace, audited with counts and never values,
 * and an import that changes nobody if anyone in it is unknown.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const h = vi.hoisted(() => ({
  user: null as any,
  members: [] as any[],
  membersResult: [] as any[],
  audit: vi.fn(),
  list: vi.fn(),
  endpoints: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
  drift: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(async () => (h.user?.role === "admin" ? h.user : NextResponse.json({ error: "Forbidden" }, { status: 403 }))),
}));
vi.mock("@/lib/audit", () => ({ recordAudit: (...a: unknown[]) => h.audit(...a) }));
vi.mock("@/lib/db", () => ({ prisma: { membership: { findMany: vi.fn(async (args: any) => { h.members.push(args); return h.membersResult; }) } } }));
vi.mock("@/lib/engine/attributes", async () => {
  const actual = await vi.importActual<typeof import("@/lib/engine/attributes")>("@/lib/engine/attributes");
  return {
    ...actual,
    listMemberAttributes: (...a: unknown[]) => h.list(...a),
    engineEndpoints: (...a: unknown[]) => h.endpoints(...a),
    replaceAttribute: (...a: unknown[]) => h.replace(...a),
    pushPairs: (...a: unknown[]) => h.push(...a),
    driftReports: (...a: unknown[]) => h.drift(...a),
    reconcileAll: (...a: unknown[]) => h.reconcile(...a),
  };
});

import { AttributeError } from "@/lib/engine/attributes";
import { GET, PUT } from "./route";
import { POST as importRows } from "./import/route";
import { GET as drift } from "./drift/route";
import { POST as sync } from "./sync/route";


const admin = { id: "a1", role: "admin", tenantId: "t1" };
const asReq = (method: string, url: string, body?: unknown) => new NextRequest(`http://curf.test${url}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });

beforeEach(() => {
  h.user = admin;
  h.members.length = 0;
  h.membersResult = [];
  for (const f of [h.audit, h.list, h.endpoints, h.replace, h.push, h.drift, h.reconcile]) f.mockReset();
  h.list.mockResolvedValue({ members: [{ userId: "u1", email: "a@x.test", name: null, role: "viewer", attributes: { agency_code: ["A001"] } }], names: ["agency_code"] });
  h.endpoints.mockResolvedValue([{ dataSourceId: "ds1", name: "Platform", target: { baseUrl: "http://secret-internal-host:8080", source: "platform" } }]);
  h.replace.mockImplementation(async (_t: string, _u: string, name: string, values: string[]) => ({ name, values }));
  h.push.mockResolvedValue([{ dataSourceId: "ds1", name: "Platform", ok: true, entries: 1 }]);
});

describe("every attribute route is for admins only", () => {
  it("answers 403 and does nothing for anyone else", async () => {
    for (const role of ["viewer", "developer", "executive"]) {
      h.user = { id: "u", role, tenantId: "t1" };
      expect((await GET(asReq("GET", "/api/engine/attributes"))).status, role).toBe(403);
      expect((await PUT(asReq("PUT", "/api/engine/attributes", { userId: "u1", name: "a", values: [] }))).status).toBe(403);
      expect((await importRows(asReq("POST", "/api/engine/attributes/import", { rows: [{ email: "a@b.c", name: "a", value: "1" }] }))).status).toBe(403);
      expect((await drift(asReq("GET", "/api/engine/attributes/drift"))).status).toBe(403);
      expect((await sync(asReq("POST", "/api/engine/attributes/sync"))).status).toBe(403);
    }
    for (const f of [h.list, h.replace, h.push, h.drift, h.reconcile]) expect(f).not.toHaveBeenCalled();
  });
});

describe("GET /api/engine/attributes", () => {
  it("lists the workspace's people, and where changes go, without exposing the engine's address", async () => {
    const res = await GET(asReq("GET", "/api/engine/attributes"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.names).toEqual(["agency_code"]);
    expect(body.engines).toEqual([{ dataSourceId: "ds1", name: "Platform", source: "platform" }]);
    expect(JSON.stringify(body)).not.toContain("secret-internal-host");
    expect(h.list).toHaveBeenCalledWith("t1"); // the admin's own workspace, never one named in the request
  });
});

describe("PUT /api/engine/attributes", () => {
  it("saves, writes it through to the engines, and audits a count and not the values", async () => {
    const res = await PUT(asReq("PUT", "/api/engine/attributes", { userId: "u1", name: "agency_code", values: ["A001", "A002"] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: { name: "agency_code", values: ["A001", "A002"] }, sync: [{ dataSourceId: "ds1", name: "Platform", ok: true, entries: 1 }] });
    expect(h.replace).toHaveBeenCalledWith("t1", "u1", "agency_code", ["A001", "A002"]);
    expect(h.push).toHaveBeenCalledWith("t1", { id: "a1", isAdmin: true, roles: [] }, [{ userId: "u1", name: "agency_code" }]);
    const entry = h.audit.mock.calls[0][0];
    expect(entry).toMatchObject({ kind: "engine.attribute.set", target: "u1", meta: { name: "agency_code", values: 2 } });
    expect(JSON.stringify(entry)).not.toContain("A001");
  });

  it("a change the engine did not accept is still saved, and the result says which engine failed", async () => {
    h.push.mockResolvedValue([{ dataSourceId: "ds1", name: "Platform", ok: false, entries: 1, error: "The engine could not be reached." }]);
    const res = await PUT(asReq("PUT", "/api/engine/attributes", { userId: "u1", name: "agency_code", values: ["A001"] }));
    expect(res.status).toBe(200);
    expect((await res.json()).sync[0]).toMatchObject({ ok: false, error: "The engine could not be reached." });
  });

  it("answers what is wrong: bad input 400, a person who is not a member 404", async () => {
    expect((await PUT(asReq("PUT", "/api/engine/attributes", { name: "a" }))).status).toBe(400);
    expect((await PUT(asReq("PUT", "/api/engine/attributes", { userId: "u1", name: "a", values: "x" }))).status).toBe(400);
    h.replace.mockRejectedValueOnce(new AttributeError("An attribute name starts with a letter", 400));
    expect((await PUT(asReq("PUT", "/api/engine/attributes", { userId: "u1", name: "1x", values: [] }))).status).toBe(400);
    h.replace.mockRejectedValueOnce(new AttributeError("That person is not a member of this workspace.", 404));
    const res = await PUT(asReq("PUT", "/api/engine/attributes", { userId: "stranger", name: "a", values: [] }));
    expect(res.status).toBe(404);
    expect(h.push).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("POST /api/engine/attributes/import", () => {
  const rows = [
    { email: "A@x.test", name: "agency_code", value: "A001" },
    { email: "a@x.test", name: "agency_code", value: "A002" },
    { email: "b@x.test", name: "region", value: "N" },
  ];

  it("applies one set per person and attribute, and sends them to the engines once", async () => {
    h.membersResult = [{ user: { id: "u1", email: "a@x.test" } }, { user: { id: "u2", email: "b@x.test" } }];
    const res = await importRows(asReq("POST", "/api/engine/attributes/import", { rows }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ people: 2, sets: 2 });
    expect(h.replace.mock.calls.map((c) => c.slice(0, 4))).toEqual([["t1", "u1", "agency_code", ["A001", "A002"]], ["t1", "u2", "region", ["N"]]]);
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.push.mock.calls[0][2]).toEqual([{ userId: "u1", name: "agency_code" }, { userId: "u2", name: "region" }]);
    expect(h.audit.mock.calls[0][0]).toMatchObject({ kind: "engine.attribute.import", meta: { people: 2, sets: 2 } });
  });

  it("only looks for people in the admin's own workspace", async () => {
    h.membersResult = [{ user: { id: "u1", email: "a@x.test" } }, { user: { id: "u2", email: "b@x.test" } }];
    await importRows(asReq("POST", "/api/engine/attributes/import", { rows }));
    expect(h.members[0].where.tenantId).toBe("t1");
  });

  it("changes nobody if anyone is unknown, and names them, so a typo cannot quietly leave someone without access", async () => {
    h.membersResult = [{ user: { id: "u1", email: "a@x.test" } }];
    const res = await importRows(asReq("POST", "/api/engine/attributes/import", { rows }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ unknown: ["b@x.test"], unknownCount: 1 });
    expect(h.replace).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("refuses a malformed file, saying which row", async () => {
    const res = await importRows(asReq("POST", "/api/engine/attributes/import", { rows: [{ email: "a@x.test", name: "ok", value: "1" }, { email: "nobody", name: "ok", value: "1" }] }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ row: 2 });
    expect((await importRows(asReq("POST", "/api/engine/attributes/import", { rows: [] }))).status).toBe(400);
    expect((await importRows(asReq("POST", "/api/engine/attributes/import", "nonsense"))).status).toBe(400);
    expect(h.replace).not.toHaveBeenCalled();
  });
});

describe("drift and sync", () => {
  it("drift reports every engine, as the admin, for their own workspace", async () => {
    h.drift.mockResolvedValue([{ dataSourceId: "ds1", name: "Platform", ok: true, inSync: true }]);
    const res = await drift(asReq("GET", "/api/engine/attributes/drift"));
    expect(await res.json()).toEqual({ engines: [{ dataSourceId: "ds1", name: "Platform", ok: true, inSync: true }] });
    expect(h.drift).toHaveBeenCalledWith("t1", { id: "a1", isAdmin: true, roles: [] });
  });

  it("sync reconciles every engine and audits how much it sent and how many failed", async () => {
    h.reconcile.mockResolvedValue([{ dataSourceId: "ds1", ok: true, entries: 3 }, { dataSourceId: "ds2", ok: false, entries: 0, error: "x" }]);
    const res = await sync(asReq("POST", "/api/engine/attributes/sync"));
    expect((await res.json()).engines).toHaveLength(2);
    expect(h.audit.mock.calls[0][0]).toMatchObject({ kind: "engine.attribute.sync", meta: { engines: 2, sent: 3, failed: 1 } });
  });
});
