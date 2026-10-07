import { describe, expect, it, vi } from "vitest";
import { adminCall, adminList, adminUrl, fieldMessages, parseProblem } from "./adminClient";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("parseProblem", () => {
  it("reads the engine's problem JSON, with its per-field messages", () => {
    const p = parseProblem(422, { detail: "Invalid", code: "CURF_INVALID_INPUT", errors: [{ field: "sql", message: "Only SELECT" }, { field: "sql", message: "Second" }, { field: "name", message: "Required" }] });
    expect(p.message).toBe("Invalid");
    expect(p.fields).toEqual({ sql: ["Only SELECT", "Second"], name: ["Required"] });
    expect(p.stale).toBe(false);
    expect(p.unreachable).toBe(false);
  });

  it("knows a stale version from any other conflict", () => {
    expect(parseProblem(409, { code: "CURF_STALE_VERSION" }).stale).toBe(true);
    expect(parseProblem(409, { code: "CURF_CONFLICT", detail: "In use" }).stale).toBe(false);
    expect(parseProblem(400, { code: "CURF_STALE_VERSION" }).stale).toBe(false);
  });

  it("treats a gateway error as the engine being unreachable and reads Curf's {error}", () => {
    const p = parseProblem(502, { error: "The engine could not be reached." });
    expect(p.unreachable).toBe(true);
    expect(p.message).toBe("The engine could not be reached.");
  });

  it("survives garbage", () => {
    for (const body of [null, undefined, "x", 4, [], { errors: "no" }, { errors: [null, 3, { field: 1 }] }]) {
      expect(() => parseProblem(500, body)).not.toThrow();
    }
    expect(parseProblem(500, null).message).toBeNull();
  });

  it("bounds a very long message", () => {
    expect(parseProblem(422, { detail: "x".repeat(5000) }).message!.length).toBeLessThanOrEqual(600);
  });
});

describe("adminUrl", () => {
  it("goes through the proxy with the data source and only page and size", () => {
    expect(adminUrl("ds1", "/views", { page: 0, size: 50 })).toBe("/api/engine/admin/views?dataSourceId=ds1&page=0&size=50");
    expect(adminUrl("a b&c", "connections/x/test")).toBe("/api/engine/admin/connections/x/test?dataSourceId=a+b%26c");
  });
});

describe("adminCall", () => {
  it("sends a JSON body as the body, never in the address", async () => {
    const fetchImpl = vi.fn(async () => json(201, { id: "1" }));
    const r = await adminCall("ds", "POST", "/connections", { body: { name: "x", password: "s3cret" }, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain("s3cret");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string).password).toBe("s3cret");
  });

  it("returns a problem for an error status", async () => {
    const fetchImpl = async () => json(422, { detail: "bad", errors: [{ field: "host", message: "no" }] });
    const r = await adminCall("ds", "PUT", "/connections/x", { body: {}, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem.fields.host).toEqual(["no"]);
  });

  it("handles 204 and a network failure", async () => {
    const empty = async () => new Response(null, { status: 204 });
    expect((await adminCall("ds", "DELETE", "/views/x", { fetchImpl: empty as unknown as typeof fetch })).ok).toBe(true);
    const down = async () => { throw new TypeError("network"); };
    const r = await adminCall("ds", "GET", "/views", { fetchImpl: down as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem.unreachable).toBe(true);
  });

  it("does not swallow an abort", async () => {
    const aborted = async () => { throw Object.assign(new Error("a"), { name: "AbortError" }); };
    await expect(adminCall("ds", "GET", "/views", { fetchImpl: aborted as unknown as typeof fetch })).rejects.toThrow();
  });

  it("copes with a non-JSON error page", async () => {
    const html = async () => new Response("<html>nope</html>", { status: 500 });
    const r = await adminCall("ds", "GET", "/views", { fetchImpl: html as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem.message).toBeNull();
  });
});

describe("adminList", () => {
  it("reads every page", async () => {
    const mk = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ id: from + i }));
    const pages = [{ content: mk(200, 0), page: 0, size: 200, totalElements: 250 }, { content: mk(50, 200), page: 1, size: 200, totalElements: 250 }];
    let call = 0;
    const fetchImpl = vi.fn(async () => json(200, pages[call++]));
    const r = await adminList("ds", "/views", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.ok && r.data.length).toBe(250);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns the problem when a page fails", async () => {
    const fetchImpl = async () => json(403, { detail: "no" });
    expect((await adminList("ds", "/views", { fetchImpl: fetchImpl as unknown as typeof fetch })).ok).toBe(false);
  });
});

describe("fieldMessages", () => {
  it("collects a field and its indexed children", () => {
    const p = parseProblem(422, { errors: [{ field: "rlsRules[0].column", message: "a" }, { field: "rlsRules", message: "b" }, { field: "rlsRulesX", message: "c" }] });
    expect(fieldMessages(p, "rlsRules")).toEqual(["a", "b"]);
    expect(fieldMessages(null, "x")).toEqual([]);
  });
});
