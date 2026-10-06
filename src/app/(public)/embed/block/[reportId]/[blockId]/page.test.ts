/**
 * A single-block embed (/embed/block/:reportId/:blockId) rendered any block
 * id it was given, including one gated to a role, and ran the whole report
 * to do it: the page shipped every query's rows with a one-block embed.
 * Anyone with the link loads it, so it renders as nobody, and runs only the
 * queries that one block needs.
 *
 * The real page, embed tokens and visibleReport() run here. The database
 * rows, the locale and ReportDocument are stubbed. The stub runner returns
 * rows for exactly the queries it is handed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    app: { findFirst: vi.fn(async () => null) },
    report: { findFirst: vi.fn() },
    tenant: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("@/lib/i18n/serverLocale", () => ({ serverLocale: () => "en" }));
vi.mock("@/lib/reporting/runner", async (importOriginal) => {
  const ROWS: Record<string, unknown[]> = { q_salaries: [{ name: "Alice" }], q_headcount: [{ team: "Ops" }], q_other: [{ secret: "Bob" }] };
  return {
    ...(await importOriginal<typeof import("@/lib/reporting/runner")>()),
    runReport: vi.fn(async ({ report }: any) => Object.fromEntries(report.dataSources.map((q: any) => [q.id, ROWS[q.id]]))),
  };
});
vi.mock("@/components/reports/ReportDocument", () => ({ ReportDocument: function ReportDocument() { return null; } }));

import { prisma } from "@/lib/db";
import { mintEmbedToken } from "@/lib/embed/token";
import EmbedBlockPage from "./page";

const kpi = (id: string, queryId: string, extra: object = {}) => ({
  id, type: "kpi", x: 0, y: 0, w: 4, h: 3, ...extra,
  config: { queryId, label: id, valueField: "v", format: "number" },
});
const DEFINITION = JSON.stringify({
  version: 1, name: "People", parameters: [],
  dataSources: ["q_salaries", "q_headcount", "q_other"].map((id) => ({ id, name: id, dataSourceId: "ds1", sql: "SELECT 1" })),
  pages: [{
    id: "p1", size: "A4", orientation: "portrait",
    blocks: [kpi("k_fin", "q_salaries", { visibleToRoles: ["finance"] }), kpi("k_open", "q_headcount"), kpi("k_other", "q_other")],
  }],
});

const open = (blockId: string, token?: string) =>
  EmbedBlockPage({ params: { reportId: "r1", blockId }, searchParams: token ? { token } : {} }) as Promise<any>;
const tokenFor = (blockId: string) => mintEmbedToken({ tenantId: "t1", reportId: "r1", blockId });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.report.findFirst).mockResolvedValue({ id: "r1", tenantId: "t1", definition: DEFINITION } as any);
});

describe("single-block embed", () => {
  it("renders the one block and runs only its query", async () => {
    const doc = (await open("k_open", tokenFor("k_open"))).props.children[0].props;
    expect(doc.report.pages.flatMap((p: any) => p.blocks.map((b: any) => b.id))).toEqual(["k_open"]);
    expect(doc.report.dataSources.map((q: any) => q.id)).toEqual(["q_headcount"]);
    expect(Object.keys(doc.dataset)).toEqual(["q_headcount"]);
  });

  it("won't render a gated block, even with a token minted for it before the mint route checked", async () => {
    const page = await open("k_fin", tokenFor("k_fin"));
    expect(page.props.message).toBe("Block not found in this report.");
  });

  it("won't render a gated block of a published app's report, which needs no token", async () => {
    vi.mocked(prisma.app.findFirst).mockResolvedValue({ tenantId: "t1" } as any);
    expect((await open("k_fin")).props.message).toBe("Block not found in this report.");
    const doc = (await open("k_open")).props.children[0].props;
    expect(Object.keys(doc.dataset)).toEqual(["q_headcount"]);
  });
});
