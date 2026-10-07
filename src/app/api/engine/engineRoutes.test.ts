/**
 * The engine routes' own job: who may call them, what they reject, and what status each failure becomes.
 * The work behind them (catalogue, status, workspace/visibility checks) is tested next to those modules.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const h = vi.hoisted(() => ({
  user: { id: "u1", role: "viewer", tenantId: "t1" } as any,
  admin: { id: "a1", role: "admin", tenantId: "t1" } as any,
  ctx: { target: { baseUrl: "http://e", source: "platform" }, viewer: { id: "u1", isAdmin: false, roles: [] }, tenantId: "t1", dataSource: { id: "ds1", name: "E" } } as any,
  catalogue: vi.fn(),
  check: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => h.user),
  requireAdmin: vi.fn(async () => (h.user?.role === "admin" ? h.user : NextResponse.json({ error: "Forbidden" }, { status: 403 }))),
}));
vi.mock("@/lib/engine/dataSource", async () => {
  const actual = await vi.importActual<typeof import("@/lib/engine/dataSource")>("@/lib/engine/dataSource");
  return { ...actual, engineContextFor: vi.fn(async (_u: any, id: string) => (id === "ds1" ? h.ctx : NextResponse.json({ error: "Not found" }, { status: 404 }))) };
});
vi.mock("@/lib/engine/catalogue", async () => {
  const actual = await vi.importActual<typeof import("@/lib/engine/catalogue")>("@/lib/engine/catalogue");
  return { ...actual, loadCatalogue: (...a: unknown[]) => h.catalogue(...a) };
});
vi.mock("@/lib/engine/status", () => ({ checkEngine: (...a: unknown[]) => h.check(...a) }));
vi.mock("@/lib/audit", () => ({ recordAudit: (...a: unknown[]) => h.audit(...a) }));

import { EngineCatalogueError } from "@/lib/engine/catalogue";
import { GET as listViews } from "./views/route";
import { POST as testConnection } from "./test/route";

const get = (qs: string) => new NextRequest(`http://curf.test/api/engine/views${qs}`);
const post = (body: unknown) => new NextRequest("http://curf.test/api/engine/test", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

beforeEach(() => {
  h.user = { id: "u1", role: "viewer", tenantId: "t1" };
  h.catalogue.mockReset().mockResolvedValue([{ id: "v1", name: "V", version: 1, columns: [] }]);
  h.check.mockReset().mockResolvedValue({ ok: true });
});

describe("GET /api/engine/views", () => {
  it("needs a signed-in person and a data source id", async () => {
    h.user = null;
    expect((await listViews(get("?dataSourceId=ds1"))).status).toBe(401);
    h.user = { id: "u1", role: "viewer", tenantId: "t1" };
    expect((await listViews(get(""))).status).toBe(400);
  });

  it("lists the views for a data source the person can use, any role (a report author need not be an admin)", async () => {
    const res = await listViews(get("?dataSourceId=ds1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dataSource: { id: "ds1", name: "E" }, views: [{ id: "v1", name: "V", version: 1, columns: [] }] });
  });

  it("answers 404 for a data source it will not resolve, without calling the engine", async () => {
    const res = await listViews(get("?dataSourceId=other"));
    expect(res.status).toBe(404);
    expect(h.catalogue).not.toHaveBeenCalled();
  });

  it("turns the engine's answers into the right status, and a Curf-engine disagreement into a 502", async () => {
    for (const [engineStatus, expected] of [[403, 403], [429, 429], [401, 502], [500, 502]] as const) {
      h.catalogue.mockRejectedValueOnce(new EngineCatalogueError("said no", engineStatus));
      const res = await listViews(get("?dataSourceId=ds1"));
      expect(res.status, String(engineStatus)).toBe(expected);
      expect((await res.json()).error).toBe("said no");
    }
    h.catalogue.mockRejectedValueOnce(new Error("The engine could not be reached."));
    expect((await listViews(get("?dataSourceId=ds1"))).status).toBe(502);
  });
});

describe("POST /api/engine/test", () => {
  it("is for admins only", async () => {
    expect((await testConnection(post({ dataSourceId: "ds1" }))).status).toBe(403);
    expect(h.check).not.toHaveBeenCalled();
  });

  it("needs a data source id", async () => {
    h.user = h.admin;
    expect((await testConnection(post({}))).status).toBe(400);
    expect((await testConnection(post("nonsense"))).status).toBe(400);
  });

  it("returns the diagnosis for an admin, and records that they ran it", async () => {
    h.user = h.admin;
    h.audit.mockClear();
    h.check.mockResolvedValue({ ok: false, source: "platform", problem: "p", hint: "h" });
    const res = await testConnection(post({ dataSourceId: "ds1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dataSource: { id: "ds1", name: "E" }, status: { ok: false, source: "platform", problem: "p", hint: "h" } });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ kind: "engine.test", target: "ds1", meta: { ok: false, source: "platform" } }));
  });

  it("a data source it will not resolve is a 404", async () => {
    h.user = h.admin;
    expect((await testConnection(post({ dataSourceId: "other" }))).status).toBe(404);
    expect(h.check).not.toHaveBeenCalled();
  });
});
