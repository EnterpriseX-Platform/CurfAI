import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { resolveEngineFilters, rowsFromEngineResult, runEngineQuery } from "./client";

// The platform's own engine goes over a plain connection (operator-trusted), which these tests stub; the workspace
// transport rules are in engineCall.test.ts and pinnedFetch.test.ts.
const target = { baseUrl: "http://93.184.216.34:8080", source: "platform" as const };
const viewer = { id: "u1", isAdmin: false, roles: ["analyst"] };
const query = { viewId: "v1", columns: ["id", "name"], orderBy: [{ column: "id" }], limit: 10 };

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

const respond = (status: number, body: unknown = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("resolveEngineFilters", () => {
  it("fills {$param} values from the report's parameters", () => {
    expect(resolveEngineFilters(
      [{ column: "created", op: "GE", value: { $param: "from" } }, { column: "id", op: "IN", values: [1, { $param: "extra" }] }],
      { from: "2026-02-01", extra: 9 },
    )).toEqual([{ column: "created", op: "GE", value: "2026-02-01" }, { column: "id", op: "IN", values: [1, 9] }]);
  });

  it("drops a skipIfEmpty filter whose parameter is blank, and keeps one that is not marked", () => {
    const filters = [
      { column: "agency", op: "EQ" as const, value: { $param: "agency" }, skipIfEmpty: true },
      { column: "status", op: "EQ" as const, value: { $param: "status" } },
    ];
    expect(resolveEngineFilters(filters, { agency: "", status: "" })).toEqual([{ column: "status", op: "EQ", value: "" }]);
    expect(resolveEngineFilters(filters, { agency: "A001", status: "x" }).map((f) => f.column)).toEqual(["agency", "status"]);
  });
});

describe("rowsFromEngineResult", () => {
  it("keys each row by column name, as every other Curf driver returns them", () => {
    expect(rowsFromEngineResult({ columns: [{ name: "id" }, { name: "email" }], rows: [[1, "***"], [2, null]] }))
      .toEqual([{ id: 1, email: "***" }, { id: 2, email: null }]);
    expect(rowsFromEngineResult({})).toEqual([]);
  });
});

describe("runEngineQuery", () => {
  it("posts the view query with a bearer token for this person and workspace, and returns rows by name", async () => {
    const fetchMock = respond(200, { columns: [{ name: "id" }, { name: "name" }], rows: [[1, "Somchai"]] });
    vi.stubGlobal("fetch", fetchMock);
    const rows = await runEngineQuery({ target, viewer, tenantId: "t1", query, params: {} });
    expect(rows).toEqual([{ id: 1, name: "Somchai" }]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://93.184.216.34:8080/engine/v1/queries/execute");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Record<string, string>;
    const claims = JSON.parse(Buffer.from(headers.Authorization.replace("Bearer ", "").split(".")[1], "base64url").toString());
    expect(claims).toMatchObject({ sub: "u1", tenant: "t1" });
    expect(JSON.parse(init.body as string)).toEqual({ viewId: "v1", columns: ["id", "name"], orderBy: [{ column: "id" }], limit: 10 });
  });

  it("never sends SQL, and sends no filters key when every filter was skipped", async () => {
    const fetchMock = respond(200, { columns: [], rows: [] });
    vi.stubGlobal("fetch", fetchMock);
    await runEngineQuery({
      target, viewer, tenantId: "t1", params: { agency: "" },
      query: { viewId: "v1", filters: [{ column: "agency", op: "EQ", value: { $param: "agency" }, skipIfEmpty: true }] },
    });
    const sent = JSON.parse(((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body) as string);
    expect(sent).not.toHaveProperty("sql");
    expect(sent).not.toHaveProperty("connectionId");
    expect(sent).not.toHaveProperty("filters");
  });

  it.each([
    [401, /did not accept Curf's identity/],
    [403, /does not allow this person/],
    [404, /does not exist on the engine, is not published, or is not available/],
    [429, /busy/],
    [504, /time limit/],
    [500, /failed to answer \(500\)/],
  ])("turns a %i into a short, specific message", async (status, message) => {
    vi.stubGlobal("fetch", respond(status as number));
    await expect(runEngineQuery({ target, viewer, tenantId: "t1", query, params: {} })).rejects.toThrow(message as RegExp);
  });

  it("passes on what the engine says about an invalid query, but only its first message", async () => {
    vi.stubGlobal("fetch", respond(422, { detail: "Request validation failed", errors: [{ field: "columns", message: "unknown column secret_col" }, { field: "x", message: "second" }] }));
    await expect(runEngineQuery({ target, viewer, tenantId: "t1", query, params: {} })).rejects.toThrow("The engine rejected the query: unknown column secret_col");
  });

  it("does not follow a redirect", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })));
    await expect(runEngineQuery({ target, viewer, tenantId: "t1", query, params: {} })).rejects.toThrow(/redirect/);
  });

  it("says so when the engine cannot be reached, without the address or the token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connect ECONNREFUSED 93.184.216.34:8080"); }));
    const err = (await runEngineQuery({ target, viewer, tenantId: "t1", query, params: {} }).catch((e) => e)) as Error;
    expect(err.message).toBe("The engine could not be reached.");
  });

  it("no message ever carries the token", async () => {
    let token = "";
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      token = ((init.headers as Record<string, string>).Authorization).replace("Bearer ", "");
      return new Response(JSON.stringify({ detail: token }), { status: 422 });
    }));
    const err = (await runEngineQuery({ target, viewer, tenantId: "t1", query, params: {} }).catch((e) => e)) as Error;
    expect(token.length).toBeGreaterThan(100);
    expect(err.message.includes(token)).toBe(false);
  });

  it("re-checks a workspace's own URL before every call, so a URL that is no longer allowed is not called", async () => {
    const fetchMock = respond(200);
    vi.stubGlobal("fetch", fetchMock);
    await expect(runEngineQuery({ target: { baseUrl: "http://169.254.169.254", source: "workspace" }, viewer, tenantId: "t1", query, params: {} }))
      .rejects.toThrow(/not allowed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("trusts the platform's own URL as operator configuration", async () => {
    const fetchMock = respond(200, { columns: [], rows: [] });
    vi.stubGlobal("fetch", fetchMock);
    await runEngineQuery({ target: { baseUrl: "http://engine.internal:8080", source: "platform" }, viewer, tenantId: "t1", query, params: {} });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
