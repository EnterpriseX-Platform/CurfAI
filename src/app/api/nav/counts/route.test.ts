/**
 * GET /api/nav/counts — every sidebar badge in one answer (the 2026-09-30
 * audit, P6: the Sidebar sent a dozen full-list requests per page just to
 * count them). Each count has to match what its own list route returns:
 * the same tenant scope and visibility rules. The paid badges come from
 * ee.navCounts (tested in src/ee/navCounts.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const h = vi.hoisted(() => ({
  user: null as any,
  ee: { edition: "cloud" } as any,
  rolesJson: "[]",
  sources: [] as any[],
  dashboards: [] as any[],
  onScreen: [] as any[],
}));
const db = vi.hoisted(() => ({}) as Record<string, any>);
const count = (n: number) => vi.fn(async (_args: any) => n);

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => h.user),
  tenantWhere: (u: any) => ({ tenantId: u.tenantId }),
  reportWhere: (u: any) => ({ tenantId: u.tenantId, ...(u.scopedReportIds ? { id: { in: u.scopedReportIds } } : {}) }),
  blockScopedApiKey: (u: any) => (u.scopedReportIds ? NextResponse.json({ error: "scoped" }, { status: 403 }) : null),
  memberRoleSlugs: (role: string, rolesJson: string | null | undefined) => [
    ...JSON.parse(rolesJson ?? "[]"), ...(role === "executive" ? ["executive"] : []),
  ],
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/ee", () => ({ ee: h.ee }));

import { GET } from "./route";

let seq = 0;
async function counts(query = "") {
  const res = await GET(new NextRequest(`http://localhost:3100/api/nav/counts${query}`));
  return { status: res.status, body: await res.json() };
}
const whereOf = (fn: any) => fn.mock.calls.at(-1)?.[0]?.where;

beforeEach(() => {
  // A new person per test: the route keeps each person's answer for a while.
  h.user = { id: `u${++seq}`, tenantId: "t1", role: "developer", email: "dev@test.dev" };
  h.rolesJson = "[]";
  h.ee.navCounts = { paid: vi.fn(async () => ({ notebooks: 3, inbox: 1 })) };
  h.sources = [
    { ownerUserId: null, visibleToRolesJson: "[]" },            // everyone
    { ownerUserId: null, visibleToRolesJson: '["finance"]' },   // one role
    { ownerUserId: null, visibleToRolesJson: "not json" },      // corrupt: everyone
  ];
  h.dashboards = [
    { ownerUserId: null, visibleToRolesJson: null },
    { ownerUserId: "someone-else", visibleToRolesJson: "[]" },   // their "just me"
  ];
  h.onScreen = [{ ownerUserId: null, visibleToRolesJson: "[]" }];
  Object.assign(db, {
    report: { count: count(7) },
    dataSource: { findMany: vi.fn(async () => h.sources) },
    dashboard: { findMany: vi.fn(async () => h.dashboards) },
    onScreenDisplay: { findMany: vi.fn(async () => h.onScreen) },
    membership: { findUnique: vi.fn(async () => ({ rolesJson: h.rolesJson })) },
  });
});

afterEach(() => { vi.useRealTimers(); });

describe("GET /api/nav/counts", () => {
  it("refuses no session, and a report-scoped API key", async () => {
    h.user = null;
    expect((await counts()).status).toBe(401);
    h.user = { id: "apikey:k1", tenantId: "t1", role: "viewer", viaApiKey: true, scopedReportIds: ["r1"] };
    expect((await counts()).status).toBe(403);
    expect(db.report.count).not.toHaveBeenCalled();
  });

  it("counts each list as its own route filters it, and adds the paid badges", async () => {
    const { status, body } = await counts();
    expect(status).toBe(200);
    expect(body).toEqual({
      reports: 7,
      sources: 2,      // the role-scoped one isn't theirs
      dashboards: 1,   // nor is someone else's "just me"
      onScreen: 1,
      notebooks: 3,
      inbox: 1,
    });
    expect(h.ee.navCounts.paid).toHaveBeenCalledWith(h.user);
  });

  it("scopes every query to the caller's workspace, and reads only the visibility columns", async () => {
    await counts();
    expect(whereOf(db.report.count)).toEqual({ tenantId: "t1" });
    for (const fn of [db.dataSource.findMany, db.dashboard.findMany, db.onScreenDisplay.findMany]) {
      expect(fn.mock.calls[0][0]).toEqual({ where: { tenantId: "t1" }, select: { ownerUserId: true, visibleToRolesJson: true } });
    }
    expect(db.membership.findUnique.mock.calls[0][0].where).toEqual({ userId_tenantId: { userId: h.user.id, tenantId: "t1" } });
  });

  it("lets an admin see role-scoped lists — never another person's private one", async () => {
    h.user.role = "admin";
    const { body } = await counts();
    expect(body.sources).toBe(3);
    expect(body.dashboards).toBe(1);
  });

  it("matches a member's custom roles against role-scoped lists", async () => {
    h.rolesJson = '["finance"]';
    expect((await counts()).body.sources).toBe(3);
  });

  it("gives an API key no custom roles, without a membership lookup", async () => {
    h.user = { id: `apikey:k${++seq}`, tenantId: "t1", role: "developer", viaApiKey: true };
    h.rolesJson = '["finance"]';
    expect((await counts()).body.sources).toBe(2);
    expect(db.membership.findUnique).not.toHaveBeenCalled();
  });

  it("counts only the Community lists when the paid registry is absent", async () => {
    const paid = h.ee.navCounts;
    delete h.ee.navCounts;
    expect((await counts()).body).toEqual({ reports: 7, sources: 2, dashboards: 1, onScreen: 1 });
    h.ee.navCounts = paid;
  });

  it("leaves out only what failed", async () => {
    db.dashboard.findMany = vi.fn(async () => { throw new Error("down"); });
    h.ee.navCounts.paid = vi.fn(async () => { throw new Error("paid half down"); });
    const { status, body } = await counts();
    expect(status).toBe(200);
    expect(body).toEqual({ reports: 7, sources: 2, onScreen: 1 });
  });

  it("keeps a person's answer for 30 seconds, unless asked for a fresh one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T10:00:00Z"));
    expect((await counts()).body.reports).toBe(7);
    db.report.count = count(8);
    expect((await counts()).body.reports).toBe(7);
    expect(db.report.count).not.toHaveBeenCalled();

    // Someone else in the same workspace gets their own answer.
    const first = h.user;
    h.user = { ...first, id: `u${++seq}` };
    expect((await counts()).body.reports).toBe(8);
    h.user = first;

    // After a create or delete the Sidebar asks for a fresh one.
    db.report.count = count(9);
    expect((await counts("?fresh=1")).body.reports).toBe(9);

    // And once the 30 seconds are up, it counts again.
    db.report.count = count(10);
    vi.setSystemTime(new Date("2026-09-30T10:00:29Z"));
    expect((await counts()).body.reports).toBe(9);
    vi.setSystemTime(new Date("2026-09-30T10:00:31Z"));
    expect((await counts()).body.reports).toBe(10);
  });

  it("doesn't serve one role's answer after the role changes", async () => {
    await counts();
    h.user = { ...h.user, role: "admin" };
    await counts();
    expect(h.ee.navCounts.paid).toHaveBeenCalledTimes(2);
    expect(h.ee.navCounts.paid).toHaveBeenLastCalledWith(expect.objectContaining({ role: "admin" }));
  });
});
