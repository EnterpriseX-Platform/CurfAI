/**
 * The viewer page dropped blocks hidden from the viewer's roles, then ran
 * every query anyway and passed the whole dataset to the client component.
 * So the RSC payload carried the hidden table's rows (verified live on
 * 2026-09-24), and its SQL. A `?replay=` of someone else's run did the same.
 *
 * The print render (PDF, XLSX chart capture) runs as the viewer its render
 * token names (see page.test.ts). It drops the hidden blocks' queries too.
 *
 * The real page, visibleReport() and render tokens run here. The session,
 * role slugs, database rows and the two components it renders are stubbed.
 * The stub runner returns rows for exactly the queries it is handed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ session: null as any, roles: [] as string[] }));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(async () => null) },
    tenant: { findUnique: vi.fn(async () => null) },
    report: { findFirst: vi.fn() },
    reportRun: { findFirst: vi.fn(), create: vi.fn(async () => ({})) },
    // A replayed run's source, as snapshotAccess.ts looks it up by name.
    dataSource: { findUnique: vi.fn(async () => ({ id: "ds1", kind: "sqlite", ownerUserId: null, visibleToRolesJson: "[]" })) },
  },
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getSession: vi.fn(async () => h.session), getUserRoles: vi.fn(async () => h.roles) };
});
vi.mock("@/lib/reporting/runner", async (importOriginal) => {
  const ROWS: Record<string, unknown[]> = { q_salaries: [{ name: "Alice", salary: 123456 }], q_headcount: [{ team: "Ops", people: 12 }] };
  return {
    ...(await importOriginal<typeof import("@/lib/reporting/runner")>()),
    runReportWithProof: vi.fn(async ({ report }: any) => ({
      dataset: Object.fromEntries(report.dataSources.map((q: any) => [q.id, ROWS[q.id]])),
      provenance: Object.fromEntries(report.dataSources.map((q: any) => [q.id, {}])),
    })),
  };
});
vi.mock("@/ee", () => ({ ee: {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
}));
vi.mock("./ReportViewerShell", () => ({ ReportViewerShell: function ReportViewerShell() { return null; } }));
vi.mock("@/components/reports/ReportDocument", () => ({ ReportDocument: function ReportDocument() { return null; } }));

import { prisma } from "@/lib/db";
import { runReportWithProof } from "@/lib/reporting/runner";
import { mintRenderToken } from "@/lib/reporting/renderToken";
import { mintEmbedToken } from "@/lib/embed/token";
import ViewerPage from "./page";

const col = (key: string, label: string) => ({ key, label, type: "string", align: "left", total: "none" });
const DEFINITION = JSON.stringify({
  version: 1, name: "People", parameters: [],
  dataSources: [
    { id: "q_salaries", name: "Salaries", dataSourceId: "ds1", sql: "SELECT name, salary FROM payroll" },
    { id: "q_headcount", name: "Headcount", dataSourceId: "ds1", sql: "SELECT 1" },
  ],
  pages: [{
    id: "p1", size: "A4", orientation: "portrait",
    blocks: [
      { id: "t_fin", type: "table", x: 0, y: 0, w: 12, h: 4, visibleToRoles: ["finance"], config: { queryId: "q_salaries", title: "Salaries", columns: [col("name", "Name"), col("salary", "Salary")] } },
      { id: "t_open", type: "table", x: 0, y: 4, w: 12, h: 4, config: { queryId: "q_headcount", title: "Headcount", columns: [col("team", "Team"), col("people", "People")] } },
    ],
  }],
});

const open = (searchParams: Record<string, string> = {}) => ViewerPage({ params: { id: "r1" }, searchParams }) as Promise<any>;
/** The props of the element the page rendered with this component (the print branch wraps it in a div). */
function propsOf(tree: any, name: string): any {
  if (!tree || typeof tree !== "object") return null;
  if (tree.type?.name === name) return tree.props;
  for (const child of [tree.props?.children].flat()) {
    const found = propsOf(child, name);
    if (found) return found;
  }
  return null;
}
const blockIds = (report: any) => report.pages.flatMap((p: any) => p.blocks.map((b: any) => b.id));
const ranWith = () => vi.mocked(runReportWithProof).mock.calls[0][0];

beforeEach(() => {
  vi.clearAllMocks();
  h.session = { user: { id: "u-viewer", role: "viewer", tenantId: "t1" } };
  h.roles = [];
  vi.mocked(prisma.report.findFirst).mockResolvedValue({
    id: "r1", tenantId: "t1", name: "People", version: 1, updatedAt: new Date(), definition: DEFINITION,
  } as any);
});

describe("viewer page — what reaches the browser for blocks hidden by role", () => {
  it("sends neither the hidden block's query nor its rows", async () => {
    const shell = propsOf(await open(), "ReportViewerShell");
    expect(blockIds(shell.report)).toEqual(["t_open"]);
    expect(shell.report.dataSources.map((q: any) => q.id)).toEqual(["q_headcount"]);
    expect(Object.keys(shell.initialDataset)).toEqual(["q_headcount"]);
    expect(JSON.stringify(shell)).not.toContain("Alice");
    expect(JSON.stringify(shell)).not.toContain("payroll");
  });

  it("records the load as restricted, so it never becomes a KPI baseline", async () => {
    await open();
    expect(vi.mocked(prisma.reportRun.create).mock.calls[0][0].data).toMatchObject({
      status: "restricted", error: "1 of 2 queries were hidden from this viewer",
    });
  });

  it("sends both to a viewer who holds the role", async () => {
    h.roles = ["finance"];
    const shell = propsOf(await open(), "ReportViewerShell");
    expect(shell.initialDataset.q_salaries).toEqual([{ name: "Alice", salary: 123456 }]);
  });

  it("replays only what this viewer's report reads from a run someone else recorded", async () => {
    // An admin's run holds the hidden block's rows, and one recorded
    // against an older version of the report can hold a query since removed.
    vi.mocked(prisma.reportRun.findFirst).mockResolvedValue({
      id: "run-admin", createdAt: new Date(), params: "{}",
      dataset: JSON.stringify({ q_salaries: [{ name: "Alice" }], q_headcount: [{ team: "Ops" }], q_removed: [{ secret: 1 }] }),
      provenance: JSON.stringify({
        q_salaries: { rowCount: 1, dataSourceName: "hr" },
        q_headcount: { rowCount: 1, dataSourceName: "hr" },
        q_removed: { rowCount: 1, dataSourceName: "hr" },
      }),
    } as any);
    const shell = propsOf(await open({ replay: "run-admin" }), "ReportViewerShell");
    expect(Object.keys(shell.initialDataset)).toEqual(["q_headcount"]);
    expect(Object.keys(shell.initialProvenance)).toEqual(["q_headcount"]);
  });
});

describe("viewer page — a print render drops the hidden blocks' queries too", () => {
  beforeEach(() => { h.session = null; });
  const print = (viewer: { id: string; isAdmin: boolean; roles: string[] }, blocksAsViewer?: boolean) =>
    open({ print: "1", rt: mintRenderToken({ tenantId: "t1", reportId: "r1", viewer, blocksAsViewer }) });

  it("an API key's export runs only the queries behind blocks the key may see", async () => {
    const doc = propsOf(await print({ id: "key-1", isAdmin: false, roles: [] }, true), "ReportDocument");
    expect(blockIds(doc.report)).toEqual(["t_open"]);
    expect(ranWith().report.dataSources.map((q: any) => q.id)).toEqual(["q_headcount"]);
    expect(Object.keys(doc.dataset)).toEqual(["q_headcount"]);
  });

  it("a delivery filters blocks as nobody, and skips their queries, though its data runs as the creator", async () => {
    const creator = { id: "u-admin", isAdmin: true, roles: [] };
    const doc = propsOf(await print(creator), "ReportDocument");
    expect(ranWith().viewer).toEqual(creator);
    expect(blockIds(doc.report)).toEqual(["t_open"]);
    expect(Object.keys(doc.dataset)).toEqual(["q_headcount"]);
  });

  it("an embed token is not a render token", async () => {
    // A one-block embed link rendered the whole report this way.
    const rt = mintEmbedToken({ tenantId: "t1", reportId: "r1", blockId: "t_open" });
    await expect(open({ print: "1", rt })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(runReportWithProof).not.toHaveBeenCalled();
  });
});
