/**
 * Recommend-KPIs sends a data source's tables, columns and (for a lake
 * source) sample rows to the model. It looked the source up by id within the
 * workspace only, so a builder could have the model read a source restricted
 * to roles they don't hold, or someone's owner-only one. A source the caller
 * can't see (canSeeDataSource) is now a 404, and the introspection runs as
 * the caller, so a lake source lists only the tables they may read, masked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ user: null as any, roles: [] as string[], ds: null as any }));

vi.mock("@/lib/db", () => ({
  prisma: { dataSource: { findFirst: vi.fn(async () => h.ds) } },
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireAdminOrEditor: vi.fn(async () => h.user), getUserRoles: vi.fn(async () => h.roles) };
});
vi.mock("@/lib/reporting/runner", () => ({ ANONYMOUS_VIEWER: { id: "anonymous", isAdmin: false, roles: [] } }));
vi.mock("@/lib/llm", () => ({ callLLM: vi.fn() }));
vi.mock("@/app/api/reports/generate/route", () => ({
  introspectTables: vi.fn(async () => ({ dataSourceName: "Sales DB", kind: "postgres", tables: [{ name: "orders", columns: [{ name: "amount", type: "numeric" }], sample: null }] })),
}));

import { prisma } from "@/lib/db";
import { callLLM } from "@/lib/llm";
import { introspectTables } from "@/app/api/reports/generate/route";
import { POST } from "./route";

const post = () => POST(new NextRequest("http://localhost:3100/api/dashboards/recommend-kpis", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ dataSourceId: "ds1" }),
}));
const source = (over: Record<string, unknown> = {}) => ({
  id: "ds1", name: "Sales DB", kind: "postgres", connection: "enc", discoveredSchemaJson: null,
  visibleToRolesJson: "[]", ownerUserId: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.user = { id: "u-dev", role: "developer", tenantId: "t1", email: "d@test.dev" };
  h.roles = ["finance"];
  h.ds = source();
  vi.mocked(callLLM).mockResolvedValue({ text: '[{"label":"Total","sql":"SELECT SUM(amount) FROM orders","format":"currency"}]' } as any);
});

describe("POST /api/dashboards/recommend-kpis — only a source the caller can see", () => {
  it("404s a source restricted to a role the caller lacks, before introspecting it or calling the model", async () => {
    h.ds = source({ visibleToRolesJson: JSON.stringify(["hr"]) });

    const res = await post();

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Data source not found");
    expect(introspectTables).not.toHaveBeenCalled();
    expect(callLLM).not.toHaveBeenCalled();
  });

  it("404s someone else's owner-only source, admin included", async () => {
    h.user = { id: "u-admin", role: "admin", tenantId: "t1", email: "a@test.dev" };
    h.ds = source({ ownerUserId: "u-owner" });

    const res = await post();

    expect(res.status).toBe(404);
    expect(callLLM).not.toHaveBeenCalled();
  });

  it("looks the source up inside the caller's workspace", async () => {
    await post();
    expect(vi.mocked(prisma.dataSource.findFirst).mock.calls[0][0]).toMatchObject({ where: { id: "ds1", tenantId: "t1" } });
  });

  it("introspects a source shared with one of the caller's roles as the caller, then asks the model", async () => {
    h.ds = source({ visibleToRolesJson: JSON.stringify(["finance"]) });

    const res = await post();

    expect(res.status).toBe(200);
    expect((await res.json()).kpis).toHaveLength(1);
    expect(vi.mocked(introspectTables).mock.calls[0][1]).toEqual({ id: "u-dev", isAdmin: false, roles: ["finance"] });
    expect(callLLM).toHaveBeenCalledTimes(1);
  });
});
