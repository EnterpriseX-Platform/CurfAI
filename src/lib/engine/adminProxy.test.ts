import { describe, expect, it } from "vitest";
import { ADMIN_BODY_MAX_BYTES, adminAuditMeta, adminQuery, matchAdminRoute } from "./adminProxy";

const ID = "3f2b8c1e-9d4a-4e7b-a1c2-5d6e7f8a9b0c";
const m = (method: string, path: string) => matchAdminRoute(method, path.split("/").filter(Boolean));

describe("matchAdminRoute: what an admin console may reach", () => {
  it.each([
    ["GET", "/views"], ["POST", "/views"],
    ["GET", `/views/${ID}`], ["PUT", `/views/${ID}`], ["DELETE", `/views/${ID}`],
    ["GET", `/views/${ID}/summary`], ["GET", `/views/${ID}/versions`],
    ["POST", `/views/${ID}/preview`], ["POST", `/views/${ID}/publish`], ["POST", `/views/${ID}/unpublish`],
    ["GET", "/connections"], ["POST", "/connections"],
    ["GET", `/connections/${ID}`], ["PUT", `/connections/${ID}`], ["DELETE", `/connections/${ID}`],
    ["POST", `/connections/${ID}/test`], ["POST", `/connections/${ID}/introspect`],
    ["GET", "/policies/entitlements"], ["PUT", "/policies/entitlements"],
    ["GET", "/audit-events"],
  ])("%s %s", (method, path) => {
    expect(m(method, path)).toEqual({ ok: true, path });
  });

  it("treats the method case-insensitively, and an upper-case id as an id", () => {
    expect(m("get", "/views")).toEqual({ ok: true, path: "/views" });
    expect(m("GET", `/views/${ID.toUpperCase()}`)).toMatchObject({ ok: true });
  });

  it("is a 405 for a path that exists with another method", () => {
    for (const [method, path] of [["DELETE", "/views"], ["PUT", "/views"], ["POST", `/views/${ID}`], ["GET", `/views/${ID}/publish`],
      ["DELETE", "/policies/entitlements"], ["POST", "/audit-events"], ["GET", `/connections/${ID}/test`], ["PUT", "/connections"]] as const) {
      expect(m(method, path), `${method} ${path}`).toEqual({ ok: false, status: 405 });
    }
  });

  it("is a 404 for every other engine endpoint, so the proxy never becomes a way to reach all of the engine with an admin's token", () => {
    for (const path of [
      "/me", "/reports", `/reports/${ID}`, `/reports/${ID}/run`, "/exports", `/exports/${ID}/file`, "/schedules", `/schedules/${ID}`,
      "/queries/execute", "/publish-requests", `/public/${ID}`, "/public-links", "/actuator/health", "/actuator/prometheus",
      `/views/${ID}/delete`, `/views/${ID}/summary/extra`, "/policies", "/policies/other", `/connections/${ID}/secrets`,
    ]) {
      expect(m("GET", path), path).toEqual({ ok: false, status: 404 });
      expect(m("POST", path), path).toEqual({ ok: false, status: 404 });
    }
  });

  it("refuses anything that is not a plain identifier segment: traversal, encodings, separators, empties", () => {
    const bad = [["views", ".."], ["views", "."], ["..", "me"], ["views", "%2e%2e"], ["views", "a/b"], ["views", ID, "..", "me"], ["views", `${ID}%2fpublish`],
      ["views\\..\\me"], ["views", "a b"], ["views", ""], ["views", "x".repeat(65)], ["views;x"], ["views?x=1"], ["views#"], ["vïews"]];
    for (const segments of bad) expect(matchAdminRoute("GET", segments), JSON.stringify(segments)).toEqual({ ok: false, status: 404 });
    expect(matchAdminRoute("GET", [])).toEqual({ ok: false, status: 404 });
    expect(matchAdminRoute("GET", ["views", ID, "a", "b", "c"])).toEqual({ ok: false, status: 404 });
  });

  it("an id of the wrong shape is not an id", () => {
    for (const id of ["1", "abc", ID.slice(0, 35), ID + "0", ID.replace(/-/g, "_")]) expect(m("GET", `/views/${id}`), id).toEqual({ ok: false, status: 404 });
  });
});

describe("adminQuery", () => {
  it("passes on paging and entitlement filters only, encoded", () => {
    expect(adminQuery(new URLSearchParams("page=2&size=50&subject=u%401&attribute=agency_code"))).toBe("?page=2&size=50&subject=u%401&attribute=agency_code");
  });

  it("drops everything else the browser sent, including the data source id the proxy itself uses", () => {
    expect(adminQuery(new URLSearchParams("dataSourceId=ds1&admin=true&sql=drop&size=10"))).toBe("?size=10");
    expect(adminQuery(new URLSearchParams("dataSourceId=ds1"))).toBe("");
    expect(adminQuery(new URLSearchParams(""))).toBe("");
  });

  it("will not carry a value that is absurdly long, or one that tries to start another parameter", () => {
    expect(adminQuery(new URLSearchParams({ subject: "x".repeat(256) }))).toBe("");
    expect(adminQuery(new URLSearchParams({ subject: "a&admin=true" }))).toBe("?subject=a%26admin%3Dtrue");
  });
});

describe("the rest", () => {
  it("the audit record names the method and path, and has no place for a body (it may hold a password)", () => {
    expect(adminAuditMeta("post", `/connections/${ID}`)).toEqual({ method: "POST", path: `/connections/${ID}` });
  });
  it("bodies are bounded", () => {
    expect(ADMIN_BODY_MAX_BYTES).toBe(1024 * 1024);
  });
});
