import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sources: [] as any[],
  memberships: [] as any[],
  held: [] as any[],
  call: vi.fn(),
  tx: vi.fn(),
  deleted: [] as any[],
  created: [] as any[],
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    dataSource: { findMany: vi.fn(async () => h.sources) },
    membership: {
      findMany: vi.fn(async () => h.memberships),
      findUnique: vi.fn(async ({ where }: any) => (h.memberships.some((m) => m.user.id === where.userId_tenantId.userId) ? { id: "m" } : null)),
    },
    userAttribute: {
      findMany: vi.fn(async ({ where }: any) => {
        if (!where.OR) return h.held;
        return h.held.filter((r) => where.OR.some((p: any) => p.userId === r.userId && p.name === r.name));
      }),
      deleteMany: vi.fn((args: any) => { h.deleted.push(args); return { op: "delete", args }; }),
      createMany: vi.fn((args: any) => { h.created.push(args); return { op: "create", args }; }),
    },
    $transaction: vi.fn(async (ops: any[]) => { h.tx(ops); return ops; }),
  },
}));
vi.mock("@/lib/engine/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/engine/client")>("@/lib/engine/client");
  return { ...actual, engineCall: (...a: unknown[]) => h.call(...a) };
});

import {
  AttributeError, driftReports, engineEndpoints, fetchEngineRows, listMemberAttributes, pushPairs, reconcileAll, replaceAttribute,
} from "./attributes";

const actor = { id: "admin1", isAdmin: true, roles: [] as string[] };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const own = (url: string) => JSON.stringify({ baseUrl: url });
const page = (rows: Array<[string, string, string]>) => json(200, { content: rows.map(([subject, attribute, value]) => ({ subject, attribute, value })), page: 0, size: 200, totalElements: rows.length });

beforeEach(() => {
  h.sources = [{ id: "ds1", name: "Platform", connection: "{}" }];
  h.memberships = [
    { role: "admin", user: { id: "u1", email: "a@x.test", name: "A" } },
    { role: "viewer", user: { id: "u2", email: "b@x.test", name: null } },
  ];
  h.held = [];
  h.deleted = []; h.created = [];
  h.call.mockReset();
  h.tx.mockReset();
  process.env.CURF_ENGINE_URL = "http://engine.internal:8080";
});

describe("engineEndpoints", () => {
  it("lists the workspace's engines once each: two connections to one engine are one engine", async () => {
    h.sources = [
      { id: "a", name: "A", connection: "{}" },
      { id: "b", name: "B", connection: "{}" },
      { id: "c", name: "C", connection: own("https://own.example") },
      { id: "d", name: "D", connection: own("https://own.example") },
      { id: "e", name: "E", connection: JSON.stringify({ baseUrl: "https://own.example", audience: "other" }) },
    ];
    const eps = await engineEndpoints("t1");
    expect(eps.map((e) => e.dataSourceId)).toEqual(["a", "c", "e"]);
  });

  it("skips a connection that has no usable URL", async () => {
    delete process.env.CURF_ENGINE_URL;
    h.sources = [{ id: "a", name: "A", connection: "{}" }, { id: "c", name: "C", connection: own("https://own.example") }];
    expect((await engineEndpoints("t1")).map((e) => e.dataSourceId)).toEqual(["c"]);
  });
});

describe("listMemberAttributes", () => {
  it("shows every member with what they hold, and the attribute names in use", async () => {
    h.held = [
      { userId: "u1", name: "agency_code", value: "A001" },
      { userId: "u1", name: "agency_code", value: "A002" },
      { userId: "u1", name: "region", value: "N" },
    ];
    const out = await listMemberAttributes("t1");
    expect(out.names).toEqual(["agency_code", "region"]);
    expect(out.members).toEqual([
      { userId: "u1", email: "a@x.test", name: "A", role: "admin", attributes: { agency_code: ["A001", "A002"], region: ["N"] } },
      { userId: "u2", email: "b@x.test", name: null, role: "viewer", attributes: {} },
    ]);
  });
});

describe("replaceAttribute", () => {
  it("replaces what the person holds in one transaction, scoped to the workspace", async () => {
    const saved = await replaceAttribute("t1", "u1", "agency_code", [" A001 ", "A001", "A002"]);
    expect(saved).toEqual({ name: "agency_code", values: ["A001", "A002"] });
    expect(h.deleted[0]).toEqual({ where: { tenantId: "t1", userId: "u1", name: "agency_code" } });
    expect(h.created[0].data).toEqual([
      { tenantId: "t1", userId: "u1", name: "agency_code", value: "A001" },
      { tenantId: "t1", userId: "u1", name: "agency_code", value: "A002" },
    ]);
    expect(h.tx).toHaveBeenCalledTimes(1);
  });

  it("an empty list removes the attribute and creates nothing", async () => {
    await replaceAttribute("t1", "u1", "agency_code", []);
    expect(h.deleted).toHaveLength(1);
    expect(h.created).toHaveLength(0);
  });

  it("refuses a bad name, bad values, and someone who is not a member of this workspace, changing nothing", async () => {
    await expect(replaceAttribute("t1", "u1", "1bad", ["x"])).rejects.toThrow(AttributeError);
    await expect(replaceAttribute("t1", "u1", "ok", "not a list")).rejects.toThrow(AttributeError);
    await expect(replaceAttribute("t1", "u1", "ok", ["x".repeat(201)])).rejects.toThrow(AttributeError);
    await expect(replaceAttribute("t1", "stranger", "ok", ["x"])).rejects.toMatchObject({ status: 404 });
    expect(h.tx).not.toHaveBeenCalled();
  });
});

describe("pushPairs", () => {
  it("sends Curf's current set for the pairs that changed, and an empty set for one that was cleared", async () => {
    h.held = [{ userId: "u1", name: "agency_code", value: "A001" }, { userId: "u1", name: "agency_code", value: "A002" }];
    h.call.mockResolvedValue(json(200, { updated: 2 }));
    const results = await pushPairs("t1", actor, [{ userId: "u1", name: "agency_code" }, { userId: "u2", name: "agency_code" }]);
    expect(results).toEqual([{ dataSourceId: "ds1", name: "Platform", ok: true, entries: 2 }]);
    expect(h.call.mock.calls[0][0]).toMatchObject({ method: "PUT", path: "/policies/entitlements", viewer: actor, tenantId: "t1" });
    expect(h.call.mock.calls[0][0].body.entries).toEqual([
      { subject: "u1", attribute: "agency_code", values: ["A001", "A002"] },
      { subject: "u2", attribute: "agency_code", values: [] },
    ]);
  });

  it("goes to every engine of the workspace, and one failing does not stop the others or hide the failure", async () => {
    h.sources = [{ id: "a", name: "A", connection: "{}" }, { id: "b", name: "B", connection: own("https://own.example") }];
    h.call.mockImplementation(async (o: any) => (o.target.source === "workspace" ? json(503, {}) : json(200, {})));
    const results = await pushPairs("t1", actor, [{ userId: "u1", name: "n" }]);
    expect(results.map((r) => [r.dataSourceId, r.ok])).toEqual([["a", true], ["b", false]]);
    expect(results[1].error).toMatch(/not ready/);
  });

  it("does nothing when there is nothing to send, and says so when there is no engine at all", async () => {
    expect(await pushPairs("t1", actor, [])).toEqual([]);
    h.sources = [];
    expect(await pushPairs("t1", actor, [{ userId: "u1", name: "n" }])).toEqual([]);
    expect(h.call).not.toHaveBeenCalled();
  });

  it("a failure from the engine is a result, never an exception: the change is already saved in Curf", async () => {
    h.call.mockRejectedValue(new Error("The engine could not be reached."));
    const [r] = await pushPairs("t1", actor, [{ userId: "u1", name: "n" }]);
    expect(r).toMatchObject({ ok: false, error: "The engine could not be reached." });
  });
});

describe("fetchEngineRows", () => {
  const ep = { dataSourceId: "ds1", name: "P", target: { baseUrl: "http://e", source: "platform" as const } };

  it("reads every page", async () => {
    const full = Array.from({ length: 200 }, (_, i) => [`s${i}`, "a", "v"] as [string, string, string]);
    h.call.mockResolvedValueOnce(page(full)).mockResolvedValueOnce(page([["last", "a", "v"]]));
    const out = await fetchEngineRows(ep, actor, "t1");
    expect(out.rows).toHaveLength(201);
    expect(out.complete).toBe(true);
    expect(h.call.mock.calls.map((c) => c[0].path)).toEqual(["/policies/entitlements?page=0&size=200", "/policies/entitlements?page=1&size=200"]);
  });

  it("says it did not read everything, rather than pretending, when the engine holds too many", async () => {
    const full = Array.from({ length: 200 }, (_, i) => [`s${i}`, "a", "v"] as [string, string, string]);
    h.call.mockImplementation(async () => page(full));
    const out = await fetchEngineRows(ep, actor, "t1");
    expect(out.complete).toBe(false);
    expect(h.call).toHaveBeenCalledTimes(50);
  });

  it("ignores rows that are not entitlements, and fails with the engine's reason", async () => {
    h.call.mockResolvedValueOnce(json(200, { content: [{ subject: "s", attribute: "a", value: "v" }, { nope: 1 }, null] }));
    expect((await fetchEngineRows(ep, actor, "t1")).rows).toEqual([{ subject: "s", attribute: "a", value: "v" }]);
    h.call.mockResolvedValueOnce(json(403, {}));
    await expect(fetchEngineRows(ep, actor, "t1")).rejects.toThrow(/does not allow/);
  });
});

describe("driftReports", () => {
  it("in sync when both hold the same", async () => {
    h.held = [{ userId: "u1", name: "agency_code", value: "A001" }];
    h.call.mockResolvedValue(page([["u1", "agency_code", "A001"]]));
    const [r] = await driftReports("t1", actor);
    expect(r).toMatchObject({ ok: true, inSync: true, missingOnEngine: 0, extraOnEngine: 0, complete: true });
  });

  it("says who is missing on the engine (sees too little) and who is extra there (sees too much)", async () => {
    h.held = [{ userId: "u1", name: "agency_code", value: "A001" }];
    h.call.mockResolvedValue(page([["u9", "agency_code", "ZZZ"]]));
    const [r] = await driftReports("t1", actor);
    expect(r).toMatchObject({ ok: true, inSync: false, missingOnEngine: 1, extraOnEngine: 1 });
    expect(r.examples!.missingOnEngine).toEqual([{ subject: "u1", attribute: "agency_code", value: "A001" }]);
    expect(r.examples!.extraOnEngine).toEqual([{ subject: "u9", attribute: "agency_code", value: "ZZZ" }]);
  });

  it("is never 'in sync' on a partial read", async () => {
    const full = Array.from({ length: 200 }, (_, i) => [`s${i}`, "a", "v"] as [string, string, string]);
    h.held = full.map(([userId, name, value]) => ({ userId, name, value }));
    h.call.mockImplementation(async () => page(full));
    const [r] = await driftReports("t1", actor);
    expect(r.complete).toBe(false);
    expect(r.inSync).toBe(false);
  });

  it("an engine that cannot be read is reported, with the others still checked", async () => {
    h.sources = [{ id: "a", name: "A", connection: "{}" }, { id: "b", name: "B", connection: own("https://own.example") }];
    h.call.mockImplementation(async (o: any) => (o.target.source === "workspace" ? json(500, {}) : page([])));
    const reports = await driftReports("t1", actor);
    expect(reports.map((r) => [r.dataSourceId, r.ok])).toEqual([["a", true], ["b", false]]);
  });
});

describe("reconcileAll", () => {
  it("sends nothing to an engine that already agrees", async () => {
    h.held = [{ userId: "u1", name: "agency_code", value: "A001" }];
    h.call.mockResolvedValue(page([["u1", "agency_code", "A001"]]));
    expect(await reconcileAll("t1", actor)).toEqual([{ dataSourceId: "ds1", name: "Platform", ok: true, entries: 0 }]);
    expect(h.call).toHaveBeenCalledTimes(1); // the read only
  });

  it("fixes what differs: the full set for a changed pair, removal for one Curf no longer holds", async () => {
    h.held = [{ userId: "u1", name: "agency_code", value: "A001" }, { userId: "u1", name: "agency_code", value: "A002" }];
    h.call.mockImplementation(async (o: any) => (o.method === "PUT" ? json(200, {}) : page([["u1", "agency_code", "A001"], ["gone", "agency_code", "Q"]])));
    const [r] = await reconcileAll("t1", actor);
    expect(r).toMatchObject({ ok: true, entries: 2 });
    const put = h.call.mock.calls.find((c) => c[0].method === "PUT")![0];
    expect(put.body.entries).toEqual([
      { subject: "u1", attribute: "agency_code", values: ["A001", "A002"] },
      { subject: "gone", attribute: "agency_code", values: [] },
    ]);
  });

  it("changes nothing when it could not read all the engine holds: a removal based on half a picture would be wrong", async () => {
    const full = Array.from({ length: 200 }, (_, i) => [`s${i}`, "a", "v"] as [string, string, string]);
    h.call.mockImplementation(async () => page(full));
    const [r] = await reconcileAll("t1", actor);
    expect(r).toMatchObject({ ok: false, entries: 0 });
    expect(h.call.mock.calls.every((c) => c[0].method !== "PUT")).toBe(true);
  });
});
