/**
 * GET /api/reports/:id and GET /api/v1/reports/:id returned the whole stored
 * definition to any reader: the blocks the author hid from their role, and
 * every query's SQL. MCP get_report and curf://reports/{id} call the v1
 * handler. mv-prefill handed out the report's first SQL query the same way.
 *
 * Someone who can edit the report (admin, developer) still gets all of it,
 * since a filtered copy saved back would delete the hidden blocks. The real
 * routes and readableDefinition() run here. Only the caller, their custom
 * role slugs and the stored row are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ user: null as any, roles: [] as string[] }));

vi.mock("@/lib/db", () => ({ prisma: { report: { findFirst: vi.fn() } } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireUser: vi.fn(async () => h.user), getUserRoles: vi.fn(async () => h.roles) };
});

import { prisma } from "@/lib/db";
import { GET as v1Get } from "./route";
import { GET as internalGet } from "@/app/api/reports/[id]/route";
import { GET as mvPrefill } from "@/app/api/reports/[id]/mv-prefill/route";

const col = (key: string, label: string) => ({ key, label, type: "string", align: "left", total: "none" });
const DEFINITION = {
  version: 1, name: "People", parameters: [],
  dataSources: [
    { id: "q_salaries", name: "Salaries", dataSourceId: "ds1", sql: "SELECT name, salary FROM payroll" },
    { id: "q_headcount", name: "Headcount", dataSourceId: "ds1", sql: "SELECT team, people FROM teams" },
  ],
  pages: [{
    id: "p1", size: "A4", orientation: "portrait",
    blocks: [
      { id: "t_fin", type: "table", x: 0, y: 0, w: 12, h: 4, visibleToRoles: ["finance"], config: { queryId: "q_salaries", title: "Salaries", columns: [col("name", "Name"), col("salary", "Salary")] } },
      { id: "t_open", type: "table", x: 0, y: 4, w: 12, h: 4, config: { queryId: "q_headcount", title: "Headcount", columns: [col("team", "Team"), col("people", "People")] } },
    ],
  }],
};
const row = (definition: string) => ({
  id: "r1", tenantId: "t1", name: "People", description: null, category: null, version: 3,
  published: true, createdAt: new Date(), updatedAt: new Date(), definition,
});

const call = (route: any, path: string) => route(new NextRequest(`http://localhost:3100${path}`), { params: { id: "r1" } });
const blockIds = (def: any) => def.pages.flatMap((p: any) => p.blocks.map((b: any) => b.id));

beforeEach(() => {
  vi.clearAllMocks();
  h.user = { id: "key-1", email: null, role: "viewer", tenantId: "t1", viaApiKey: true };
  h.roles = [];
  vi.mocked(prisma.report.findFirst).mockResolvedValue(row(JSON.stringify(DEFINITION)) as any);
});

describe.each([
  ["GET /api/v1/reports/:id", v1Get, "/api/v1/reports/r1"],
  ["GET /api/reports/:id", internalGet, "/api/reports/r1"],
])("%s — blocks hidden by role", (_name, route, path) => {
  it("leaves out a hidden block and its query's SQL for a viewer", async () => {
    const body = await (await call(route, path)).json();
    expect(blockIds(body.definition)).toEqual(["t_open"]);
    expect(body.definition.dataSources.map((q: any) => q.id)).toEqual(["q_headcount"]);
    expect(JSON.stringify(body)).not.toContain("payroll");
  });

  it("keeps them for a viewer who holds the role", async () => {
    h.user = { id: "u-fin", email: "f@test.dev", role: "viewer", tenantId: "t1" };
    h.roles = ["finance"];
    const body = await (await call(route, path)).json();
    expect(blockIds(body.definition)).toEqual(["t_fin", "t_open"]);
  });

  it("returns the stored definition untouched to someone who can edit it", async () => {
    // A filtered copy saved back through PUT would delete the hidden block.
    for (const role of ["admin", "developer"]) {
      h.user = { ...h.user, role };
      const body = await (await call(route, path)).json();
      expect(body.definition).toEqual(DEFINITION);
    }
  });

  it("returns no definition to a viewer when the stored one doesn't parse, rather than all of it", async () => {
    vi.mocked(prisma.report.findFirst).mockResolvedValue(row(JSON.stringify({ ...DEFINITION, pages: [] })) as any);
    const body = await (await call(route, path)).json();
    expect(body.definition).toBeNull();
  });
});

describe("GET /api/reports/:id/mv-prefill — blocks hidden by role", () => {
  it("suggests the first query a viewer may read, not the hidden block's", async () => {
    const body = await (await call(mvPrefill, "/api/reports/r1/mv-prefill")).json();
    expect(body.suggestedSql).toBe("SELECT team, people FROM teams");
  });
});
