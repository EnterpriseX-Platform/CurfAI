import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type { EngineFetch } from "./client";
import { EngineCatalogueError, loadCatalogue, toCatalogueView } from "./catalogue";

const saved = { key: process.env.CURF_ENGINE_SIGNING_KEY, iss: process.env.CURF_ENGINE_ISSUER };
beforeEach(() => {
  process.env.CURF_ENGINE_SIGNING_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.CURF_ENGINE_ISSUER = "https://curf.example";
});
afterEach(() => {
  for (const [name, value] of [["CURF_ENGINE_SIGNING_KEY", saved.key], ["CURF_ENGINE_ISSUER", saved.iss]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const ctx = (fetchImpl: EngineFetch) => ({ target: { baseUrl: "http://engine.internal", source: "platform" as const }, viewer: { id: "u1", isAdmin: false, roles: [] as string[] }, tenantId: "t1", fetchImpl });
const route = (routes: Record<string, (url: URL) => Response>): EngineFetch => async (url) => {
  const u = new URL(url);
  const handler = routes[u.pathname.replace("/engine/v1", "")];
  return handler ? handler(u) : json(404, {});
};

const summary = (id: string, name: string, columns: any[] = [{ name: "id", type: "integer", masked: false }]) => ({ id, name, version: 2, columns });

describe("toCatalogueView", () => {
  it("keeps what an author needs and drops what is malformed", () => {
    expect(toCatalogueView({ id: "v1", name: "Staff", description: "d", version: 3, columns: [{ name: "email", type: "varchar", label: "Email", masked: true }, { nope: 1 }, { name: "id" }] })).toEqual({
      id: "v1", name: "Staff", description: "d", version: 3,
      columns: [{ name: "email", type: "varchar", label: "Email", masked: true }, { name: "id", type: "unknown", masked: false }],
    });
    expect(toCatalogueView(null)).toBeNull();
    expect(toCatalogueView({ id: 1, name: "x", columns: [] })).toBeNull();
    expect(toCatalogueView({ id: "v", name: "x" })).toBeNull();
  });
});

describe("loadCatalogue for an ordinary person", () => {
  it("returns the summaries the engine gives them, by name", async () => {
    const list = vi.fn(() => json(200, [summary("b", "Zebra"), summary("a", "Apple"), { garbage: true }]));
    const views = await loadCatalogue(ctx(route({ "/views": list })));
    expect(views.map((v) => v.name)).toEqual(["Apple", "Zebra"]);
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe("loadCatalogue for someone who manages views on the engine", () => {
  const manager = (content: any[], totalElements = content.length) => json(200, { content, page: 0, size: 200, totalElements });
  const full = (id: string, name: string, publishedVersion: number | null) => ({
    id, name, version: 5, publishedVersion, sql: "SELECT secret FROM t", rlsRules: [{ column: "c", operator: "EQ", attribute: "a" }], allowedRoles: ["x"], piiRoles: ["hr"], bypassRoles: [],
    columns: [{ name: "id", type: "int", pii: "NONE" }],
  });

  it("keeps published views only and takes each one's summary, which says what is masked for THIS person", async () => {
    const summaries = vi.fn((u: URL) => json(200, summary(u.pathname.split("/").at(-2)!, `View ${u.pathname.split("/").at(-2)}`, [{ name: "email", type: "varchar", masked: true }])));
    const views = await loadCatalogue(ctx(route({
      "/views": () => manager([full("p1", "Published", 2), full("d1", "Draft", null)]),
      "/views/p1/summary": summaries,
      "/views/d1/summary": () => { throw new Error("a draft must not be asked for"); },
    })));
    expect(views).toHaveLength(1);
    expect(views[0].columns[0]).toMatchObject({ name: "email", masked: true });
  });

  it("never lets SQL, row rules or role lists through to the author", async () => {
    const views = await loadCatalogue(ctx(route({
      "/views": () => manager([full("p1", "Published", 1)]),
      "/views/p1/summary": () => json(200, { ...summary("p1", "Published"), sql: "SELECT secret", rlsRules: [{}], allowedRoles: ["x"] }),
    })));
    const text = JSON.stringify(views);
    for (const leak of ["secret", "rlsRules", "allowedRoles", "piiRoles", "sql"]) expect(text, leak).not.toContain(leak);
  });

  it("a view unpublished between the list and its summary is quietly left out; any other failure is not hidden", async () => {
    const list = () => manager([full("p1", "One", 1), full("p2", "Two", 1)]);
    const views = await loadCatalogue(ctx(route({
      "/views": list, "/views/p1/summary": () => json(404, {}), "/views/p2/summary": () => json(200, summary("p2", "Two")),
    })));
    expect(views.map((v) => v.id)).toEqual(["p2"]);
    await expect(loadCatalogue(ctx(route({
      "/views": list, "/views/p1/summary": () => json(200, summary("p1", "One")), "/views/p2/summary": () => json(500, {}),
    })))).rejects.toThrow(/500/);
  });

  it("reads further pages, but never more than five", async () => {
    const pages: string[] = [];
    const views = await loadCatalogue(ctx(route({
      "/views": (u) => { pages.push(u.searchParams.get("page")!); return manager([], 99_999); },
    })));
    expect(views).toEqual([]);
    expect(pages).toEqual(["0", "1", "2", "3", "4"]);
  });

  it("reads each page's views, not just the first page's", async () => {
    const views = await loadCatalogue(ctx(route({
      "/views": (u) => (u.searchParams.get("page") === "0" ? manager([full("a", "A", 1)], 250) : manager([full("b", "B", 1)], 250)),
      "/views/a/summary": () => json(200, summary("a", "A")),
      "/views/b/summary": () => json(200, summary("b", "B")),
    })));
    expect(views.map((v) => v.id)).toEqual(["a", "b"]);
  });
});

describe("loadCatalogue failures", () => {
  it("carries the engine's status so the caller can answer sensibly", async () => {
    const err = await loadCatalogue(ctx(route({ "/views": () => json(403, {}) }))).catch((e) => e);
    expect(err).toBeInstanceOf(EngineCatalogueError);
    expect(err.engineStatus).toBe(403);
    expect(err.message).toMatch(/does not allow/);
  });
});
