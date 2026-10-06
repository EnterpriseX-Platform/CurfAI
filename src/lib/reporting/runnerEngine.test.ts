/**
 * An engine data source answers per person: the engine applies the viewer's row rules and masking. The runner
 * must therefore (1) run it only as a real person, (2) never put its rows in the shared query cache, which is
 * keyed without the viewer, and (3) give each engine query its own provenance hash, since it has no SQL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";

const h = vi.hoisted(() => ({
  row: { id: "ds-engine", tenantId: "t1", name: "Engine", kind: "engine", connection: JSON.stringify({ baseUrl: "http://93.184.216.34:8080" }), ownerUserId: null, visibleToRolesJson: "[]", readOnly: false } as any,
}));

vi.mock("@/lib/db", () => ({
  prisma: { dataSource: { findFirst: vi.fn(async ({ where }: any) => (where.id === h.row.id && where.tenantId === h.row.tenantId ? h.row : null)) } },
}));

import { ANONYMOUS_VIEWER, runReportWithProof, runSingleQuery, SYSTEM_RUN } from "./runner";
import { hashQueryDef } from "./provenance";

const report = (dataSources: any[]) => ({
  version: 1, name: "Probe", parameters: [], dataSources,
  pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks: [] }],
}) as any;
const q = (extra: any = {}) => ({ id: "q", name: "Q", dataSourceId: "ds-engine", engine: { viewId: "v1", columns: ["id"] }, ...extra });
const person = (id: string) => ({ id, isAdmin: false, roles: [] as string[] });

const saved = { key: process.env.CURF_ENGINE_SIGNING_KEY, iss: process.env.CURF_ENGINE_ISSUER };
beforeEach(() => {
  process.env.CURF_ENGINE_SIGNING_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.CURF_ENGINE_ISSUER = "https://curf.example";
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, value] of [["CURF_ENGINE_SIGNING_KEY", saved.key], ["CURF_ENGINE_ISSUER", saved.iss]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** The engine answers by the `sub` of the token: u1 sees A001's rows, anyone else A002's. */
function engineByPerson() {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const token = (init.headers as Record<string, string>).Authorization.replace("Bearer ", "");
    const sub = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub;
    const rows = sub === "u1" ? [[1, "A001"]] : [[4, "A002"]];
    return new Response(JSON.stringify({ columns: [{ name: "id" }, { name: "agency" }], rows }), { status: 200 });
  });
}

describe("runner — engine data sources", () => {
  it("runs as the person asking and returns what the engine returned for them", async () => {
    vi.stubGlobal("fetch", engineByPerson());
    const mine = await runReportWithProof({ report: report([q()]), params: {}, tenantId: "t1", viewer: person("u1") });
    const theirs = await runReportWithProof({ report: report([q()]), params: {}, tenantId: "t1", viewer: person("u2") });
    expect(mine.dataset.q).toEqual([{ id: 1, agency: "A001" }]);
    expect(theirs.dataset.q).toEqual([{ id: 4, agency: "A002" }]);
    expect(mine.provenance.q.dataSourceKind).toBe("engine");
    expect(mine.provenance.q.executionError).toBeUndefined();
  });

  it("never serves one person's engine rows to another through the shared query cache", async () => {
    const fetchMock = engineByPerson();
    vi.stubGlobal("fetch", fetchMock);
    // Even with SQL on the query (which is what makes other kinds cacheable) an engine query stays out of the cache.
    const withSql = q({ sql: "SELECT 1" });
    const a = await runReportWithProof({ report: report([withSql]), params: {}, tenantId: "t1", viewer: person("u1") });
    const b = await runReportWithProof({ report: report([withSql]), params: {}, tenantId: "t1", viewer: person("u2") });
    const again = await runReportWithProof({ report: report([withSql]), params: {}, tenantId: "t1", viewer: person("u1") });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(a.dataset.q).toEqual([{ id: 1, agency: "A001" }]);
    expect(b.dataset.q).toEqual([{ id: 4, agency: "A002" }]);
    expect(again.dataset.q).toEqual(a.dataset.q);
  });

  it("will not run as the system or for an anonymous visitor: no one to speak for, so no data and a reason", async () => {
    const fetchMock = engineByPerson();
    vi.stubGlobal("fetch", fetchMock);
    for (const viewer of [SYSTEM_RUN, ANONYMOUS_VIEWER]) {
      const r = await runReportWithProof({ report: report([q()]), params: {}, tenantId: "t1", viewer });
      expect(r.dataset.q).toEqual([]);
      expect(r.provenance.q.executionError).toMatch(/per person/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(runSingleQuery(q() as any, {}, SYSTEM_RUN, "t1")).rejects.toThrow(/per person/);
  });

  it("a failing engine leaves an empty dataset and a short reason; the rest of the report still runs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const r = await runReportWithProof({ report: report([q()]), params: {}, tenantId: "t1", viewer: person("u1") });
    expect(r.dataset.q).toEqual([]);
    expect(r.provenance.q.executionError).toMatch(/does not exist on the engine/);
  });

  it("a query with no view named fails clearly", async () => {
    vi.stubGlobal("fetch", engineByPerson());
    const r = await runReportWithProof({ report: report([q({ engine: undefined })]), params: {}, tenantId: "t1", viewer: person("u1") });
    expect(r.provenance.q.executionError).toMatch(/names no view/);
  });

  it("only reaches its own workspace's engine source", async () => {
    vi.stubGlobal("fetch", engineByPerson());
    await expect(runSingleQuery(q() as any, {}, person("u1"), "other-tenant")).rejects.toThrow("DataSource not found: ds-engine");
  });

  it("runSingleQuery runs an engine query as the person", async () => {
    vi.stubGlobal("fetch", engineByPerson());
    expect(await runSingleQuery(q() as any, {}, person("u2"), "t1")).toEqual([{ id: 4, agency: "A002" }]);
  });
});

describe("provenance hash of an engine query", () => {
  it("is different for a different view, columns or filter, and follows the parameters it names", () => {
    const base = q() as any;
    const hash = (ds: any, params: any = {}) => hashQueryDef(ds, params);
    expect(hash(base)).not.toBe(hash({ ...base, engine: { viewId: "v2", columns: ["id"] } }));
    expect(hash(base)).not.toBe(hash({ ...base, engine: { viewId: "v1", columns: ["id", "agency"] } }));
    const filtered = { ...base, engine: { viewId: "v1", filters: [{ column: "created", op: "GE", value: { $param: "from" } }] } };
    expect(hash(filtered, { from: "2026-01-01" })).not.toBe(hash(filtered, { from: "2026-02-01" }));
    expect(hash(filtered, { from: "2026-01-01", unrelated: 1 })).toBe(hash(filtered, { from: "2026-01-01" }));
  });

  it("leaves every other kind's hash exactly as it was (the engine's parity tests pin them)", () => {
    const expected = "sha256:" + createHash("sha256")
      .update(JSON.stringify({ sql: "select 1", method: null, path: null, body: null, jsonPath: null, headers: null, params: {} }))
      .digest("hex").slice(0, 24);
    expect(hashQueryDef({ id: "x", name: "x", dataSourceId: "d", sql: "SELECT  1" } as any, {})).toBe(expected);
  });
});
