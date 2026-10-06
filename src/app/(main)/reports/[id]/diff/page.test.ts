/**
 * The time-travel diff compared two saved runs exactly as stored, whoever
 * made them: an admin's load carried rows from sources a viewer can't see, and
 * the diff showed those rows changing. Both runs are now read as the viewer
 * through their view of the report, so such a query diffs as empty.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ user: null as any, roles: [] as string[] }));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
  redirect: vi.fn((to: string) => { throw new Error("NEXT_REDIRECT " + to); }),
}));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    report: { findFirst: vi.fn() },
    reportRun: { findMany: vi.fn(), findFirst: vi.fn() },
    dataSource: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireUser: vi.fn(async () => h.user), getUserRoles: vi.fn(async () => h.roles) };
});
vi.mock("@/lib/reporting/diff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reporting/diff")>();
  return { ...actual, diffDatasets: vi.fn(actual.diffDatasets) };
});
vi.mock("@/components/layout/AppShell", () => ({ AppShell: () => null }));
vi.mock("@/components/layout/PageHeader", () => ({ PageHeader: () => null }));
vi.mock("@/components/ui/button", () => ({ Button: () => null }));
vi.mock("@/lib/i18n/dict", () => ({ LOCALES: ["en"], t: (_l: string, k: string) => k }));

import { prisma } from "@/lib/db";
import { diffDatasets } from "@/lib/reporting/diff";
import DiffPage from "./page";

const kpi = (id: string, queryId: string, visibleToRoles?: string[]) => ({
  id, type: "kpi", x: 0, y: 0, w: 4, h: 3, visibleToRoles, config: { queryId, label: id, valueField: "v", format: "number" },
});
const DEFINITION = JSON.stringify({
  version: 1, name: "Revenue", parameters: [],
  dataSources: [
    { id: "q", name: "Revenue", dataSourceId: "ds1", sql: "SELECT SUM(x) AS v FROM t" },
    { id: "qRestricted", name: "Margin", dataSourceId: "ds9", sql: "SELECT SUM(m) AS v FROM fin" },
    { id: "qHidden", name: "Payroll", dataSourceId: "ds2", sql: "SELECT SUM(pay) AS v FROM hr" },
  ],
  pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks: [kpi("b1", "q"), kpi("b2", "qRestricted"), kpi("b-hidden", "qHidden", ["probe-nobody"])] }],
});
const SOURCES: Record<string, object> = {
  "Sales DB": { id: "ds1", kind: "sqlite", ownerUserId: null, visibleToRolesJson: "[]" },
  "Finance DB": { id: "ds9", kind: "sqlite", ownerUserId: null, visibleToRolesJson: '["probe-nobody"]' },
  "HR DB": { id: "ds2", kind: "sqlite", ownerUserId: null, visibleToRolesJson: "[]" },
};
const prov = (queryId: string, source: string) => ({ queryId, dataSourceName: source, rowCount: 1 });
const savedRun = (id: string, n: number) => ({
  id, createdAt: new Date(), params: "{}",
  dataset: JSON.stringify({ q: [{ v: n }], qRestricted: [{ v: n * 2 }], qHidden: [{ v: n * 3 }] }),
  provenance: JSON.stringify({ q: prov("q", "Sales DB"), qRestricted: prov("qRestricted", "Finance DB"), qHidden: prov("qHidden", "HR DB") }),
});
const RUNS: Record<string, object> = { "run-old": savedRun("run-old", 100), "run-new": savedRun("run-new", 120) };

beforeEach(() => {
  vi.clearAllMocks();
  h.user = { id: "u1", email: "m@test.dev", role: "viewer", tenantId: "t1" };
  h.roles = ["finance"];
  vi.mocked(prisma.report.findFirst).mockResolvedValue({ id: "r1", tenantId: "t1", name: "Revenue", definition: DEFINITION } as any);
  vi.mocked(prisma.reportRun.findMany).mockResolvedValue([] as any);
  vi.mocked(prisma.reportRun.findFirst).mockImplementation((async (args: any) => RUNS[args.where.id] ?? null) as any);
  vi.mocked(prisma.dataSource.findUnique).mockImplementation((async (args: any) => SOURCES[args.where.tenantId_name.name] ?? null) as any);
});

describe("report diff page — both runs read as the viewer", () => {
  it("a query from a source the viewer can't see diffs as empty; a hidden block's query isn't diffed at all", async () => {
    await DiffPage({ params: { id: "r1" }, searchParams: { from: "run-old", to: "run-new" } });
    const [from, to] = vi.mocked(diffDatasets).mock.calls[0];
    expect(from).toEqual({ q: [{ v: 100 }], qRestricted: [] });
    expect(to).toEqual({ q: [{ v: 120 }], qRestricted: [] });
  });
});
