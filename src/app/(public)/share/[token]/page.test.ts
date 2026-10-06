/**
 * Public share links (/share/:token) and whole-report embeds (/embed/:token)
 * never looked at visibleToRoles: an anonymous visitor saw every block,
 * including ones the author gated to a role, with their rows. Verified live
 * on 2026-09-24. Nobody is signed in on either, so both render as nobody.
 *
 * The real pages and visibleReport() run here. The database rows, the
 * locale and ReportDocument are stubbed. The stub runner returns rows for
 * exactly the queries it is handed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    publicShareToken: { findUnique: vi.fn() },
    report: { findFirst: vi.fn() },
    tenant: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("@/lib/dbContext", () => ({ withSystemDbContext: (fn: () => unknown) => fn(), pinRequestDbContext: () => undefined }));
vi.mock("@/lib/i18n/serverLocale", () => ({ serverLocale: () => "en" }));
vi.mock("@/lib/reporting/runner", async (importOriginal) => {
  const ROWS: Record<string, unknown[]> = { q_salaries: [{ name: "Alice", salary: 123456 }], q_headcount: [{ team: "Ops", people: 12 }] };
  return {
    ...(await importOriginal<typeof import("@/lib/reporting/runner")>()),
    runReportWithProof: vi.fn(async ({ report }: any) => ({
      dataset: Object.fromEntries(report.dataSources.map((q: any) => [q.id, ROWS[q.id]])),
      provenance: {},
    })),
  };
});
vi.mock("@/components/reports/ReportDocument", () => ({ ReportDocument: function ReportDocument() { return null; } }));

import { prisma } from "@/lib/db";
import { runReportWithProof, ANONYMOUS_VIEWER } from "@/lib/reporting/runner";
import SharePage from "./page";
import EmbedPage from "@/app/(public)/embed/[token]/page";

const col = (key: string, label: string) => ({ key, label, type: "string", align: "left", total: "none" });
const DEFINITION = JSON.stringify({
  version: 1, name: "People", parameters: [],
  dataSources: [
    { id: "q_salaries", name: "Salaries", dataSourceId: "ds1", sql: "SELECT 1" },
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.publicShareToken.findUnique).mockResolvedValue({ tokenHash: "h", tenantId: "t1", reportId: "r1", expiresAt: null } as any);
  vi.mocked(prisma.report.findFirst).mockResolvedValue({ id: "r1", tenantId: "t1", name: "People", definition: DEFINITION } as any);
});

describe.each([
  ["/share/:token", () => SharePage({ params: { token: "tok" } })],
  ["/embed/:token", () => EmbedPage({ params: { token: "tok" } })],
])("%s — blocks gated to a role", (_path, open) => {
  it("renders as nobody: the gated block, its query and its rows stay out", async () => {
    const doc = propsOf(await open(), "ReportDocument");
    expect(blockIds(doc.report)).toEqual(["t_open"]);
    expect(doc.report.dataSources.map((q: any) => q.id)).toEqual(["q_headcount"]);
    expect(Object.keys(doc.dataset)).toEqual(["q_headcount"]);
    expect(JSON.stringify(doc)).not.toContain("Alice");
  });

  it("still runs as the anonymous viewer, for the data-source ACL", async () => {
    await open();
    expect(vi.mocked(runReportWithProof).mock.calls[0][0].viewer).toBe(ANONYMOUS_VIEWER);
  });
});
