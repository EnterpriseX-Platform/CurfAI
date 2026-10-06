/**
 * Executives and viewers belong in /executive (CEO 2026-09-25): Console hubs
 * send them there; a single report, dashboard or Operate request someone
 * linked them to still opens; public, auth and API paths are never touched.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("next-auth/jwt", () => ({ getToken: vi.fn() }));
const { executiveRedirectFor, movedToExecutive } = await import("./middleware");

describe("executiveRedirectFor", () => {
  it("sends Console hubs to the Executive view", () => {
    for (const p of ["/brief", "/reports", "/reports/new", "/dashboards", "/tables/x", "/admin/users", "/build", "/operate", "/operate/templates", "/ask"]) {
      expect(executiveRedirectFor(p)).toBe("/executive");
    }
    expect(executiveRedirectFor("/account")).toBe("/executive/account");
  });
  it("lets linked content through", () => {
    for (const p of ["/reports/abc123", "/dashboards/d1", "/operate/req_1", "/apps/sales", "/decisions"]) {
      expect(executiveRedirectFor(p)).toBeNull();
    }
  });
  it("never touches the Executive view, public, auth or old redirect paths", () => {
    for (const p of ["/executive", "/executive/tracking/1", "/work", "/portal", "/share/t", "/embed/x", "/login", "/"]) {
      expect(executiveRedirectFor(p)).toBeNull();
    }
  });
  it("keeps the designer and other nested report pages in the Console", () => {
    expect(executiveRedirectFor("/reports/abc123/edit")).toBe("/executive");
  });
});

describe("movedToExecutive", () => {
  it("sends the old Console paths to their Executive view pages", () => {
    expect(movedToExecutive("/home")).toBe("/executive");
    expect(movedToExecutive("/approvals")).toBe("/executive/approvals");
    expect(movedToExecutive("/assist")).toBe("/executive/assist");
    expect(movedToExecutive("/tracking")).toBe("/executive/tracking");
    expect(movedToExecutive("/tracking/abc123")).toBe("/executive/tracking/abc123");
    expect(movedToExecutive("/tracking/")).toBe("/executive/tracking");
  });
  it("leaves everything else alone", () => {
    for (const p of ["/", "/homepage", "/home/x", "/approvals/x", "/tracking/a/b", "/executive", "/executive/home", "/api/home"]) {
      expect(movedToExecutive(p)).toBeNull();
    }
  });
});
