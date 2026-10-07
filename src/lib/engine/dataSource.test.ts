/**
 * The checks every engine route shares: the data source is in the caller's workspace, is an engine, and is
 * visible to them; and the answers do not reveal which of those failed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { NextResponse } from "next/server";

const h = vi.hoisted(() => ({ rows: {} as Record<string, any>, roles: [] as string[] }));

vi.mock("@/lib/db", () => ({
  prisma: { dataSource: { findFirst: vi.fn(async ({ where }: any) => {
    const row = h.rows[where.id];
    return row && row.tenantId === where.tenantId ? row : null;
  }) } },
}));
vi.mock("@/lib/auth", () => ({
  tenantWhere: (user: any) => ({ tenantId: user.tenantId }),
  getUserRoles: vi.fn(async () => h.roles),
  memberRoleSlugs: vi.fn(),
}));

import { engineContextFor, httpStatusForEngine } from "./dataSource";

const user = { id: "u1", role: "viewer", tenantId: "t1" } as any;
const row = (over: object = {}) => ({ id: "ds1", name: "Engine", kind: "engine", connection: "{}", tenantId: "t1", ownerUserId: null, visibleToRolesJson: "[]", ...over });

const saved = { key: process.env.CURF_ENGINE_SIGNING_KEY, url: process.env.CURF_ENGINE_URL, iss: process.env.CURF_ENGINE_ISSUER };
beforeEach(() => {
  process.env.CURF_ENGINE_SIGNING_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.CURF_ENGINE_URL = "http://engine.internal:8080";
  process.env.CURF_ENGINE_ISSUER = "https://curf.example";
  h.rows = { ds1: row() };
  h.roles = [];
});
afterEach(() => {
  for (const [name, value] of [["CURF_ENGINE_SIGNING_KEY", saved.key], ["CURF_ENGINE_URL", saved.url], ["CURF_ENGINE_ISSUER", saved.iss]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const status = async (r: unknown) => (r instanceof NextResponse ? r.status : 0);

describe("engineContextFor", () => {
  it("resolves the target, the person and their workspace", async () => {
    const ctx = await engineContextFor(user, "ds1");
    expect(ctx).not.toBeInstanceOf(NextResponse);
    expect(ctx).toMatchObject({ tenantId: "t1", viewer: { id: "u1", isAdmin: false }, target: { baseUrl: "http://engine.internal:8080", source: "platform" }, dataSource: { id: "ds1", name: "Engine" } });
  });

  it("uses the connection's own URL when it has one", async () => {
    h.rows.ds1 = row({ connection: JSON.stringify({ baseUrl: "https://own.example", audience: "aud" }) });
    expect(await engineContextFor(user, "ds1")).toMatchObject({ target: { baseUrl: "https://own.example", audience: "aud", source: "workspace" } });
  });

  it("another workspace's data source, a missing one, and one of another kind all answer the same 404", async () => {
    h.rows.other = row({ id: "other", tenantId: "t2" });
    h.rows.pg = row({ id: "pg", kind: "postgres" });
    const answers = await Promise.all(["other", "missing", "pg"].map(async (id) => {
      const r = await engineContextFor(user, id);
      return { status: await status(r), body: r instanceof NextResponse ? await r.json() : null };
    }));
    for (const a of answers) expect(a).toEqual({ status: 404, body: { error: "Not found" } });
  });

  it("a connection restricted to roles the person lacks is a 404 too, and visible once they have one", async () => {
    h.rows.ds1 = row({ visibleToRolesJson: JSON.stringify(["finance"]) });
    expect(await status(await engineContextFor(user, "ds1"))).toBe(404);
    h.roles = ["finance"];
    expect(await status(await engineContextFor(user, "ds1"))).toBe(0);
  });

  it("an owner-only connection is not visible to anyone else", async () => {
    h.rows.ds1 = row({ ownerUserId: "someone-else" });
    expect(await status(await engineContextFor(user, "ds1"))).toBe(404);
  });

  it("says so when the engine is not set up on this Curf, rather than failing later", async () => {
    delete process.env.CURF_ENGINE_SIGNING_KEY;
    const r = await engineContextFor(user, "ds1");
    expect(await status(r)).toBe(503);
    expect((await (r as NextResponse).json()).error).toMatch(/CURF_ENGINE_SIGNING_KEY/);
  });

  it("a connection with no URL and no platform engine is a clear error", async () => {
    delete process.env.CURF_ENGINE_URL;
    const r = await engineContextFor(user, "ds1");
    expect(await status(r)).toBe(500);
    expect((await (r as NextResponse).json()).error).toMatch(/No engine URL/);
  });
});

describe("httpStatusForEngine", () => {
  it("passes on what the caller should see, and turns Curf-engine disagreement into a 502, not a 401 for the person", () => {
    expect([403, 404, 409, 422, 429].map(httpStatusForEngine)).toEqual([403, 404, 409, 422, 429]);
    expect([401, 500, 503, 504].map(httpStatusForEngine)).toEqual([502, 502, 502, 502]);
  });
});
