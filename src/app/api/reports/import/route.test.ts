/**
 * Importing a definition stored whatever source ids it carried. Query ids were
 * already rewired to placeholders, but an ATTACH's weren't, so an import could
 * ATTACH another workspace's data source. Now a definition naming a source
 * outside the caller's workspace is refused before the report is written.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => {
  // As Postgres would answer { tenantId, id: { in } }: ds1/ds2 are t1's, ds-theirs is t2's.
  const sources = [{ id: "ds1", tenantId: "t1" }, { id: "ds2", tenantId: "t1" }, { id: "ds-theirs", tenantId: "t2" }];
  return {
    prisma: {
      report: { create: vi.fn(async ({ data }: any) => ({ id: "r-new", name: data.name })) },
      dataSource: {
        findMany: vi.fn(async ({ where }: any) =>
          sources.filter((s) => s.tenantId === where.tenantId && where.id.in.includes(s.id)).map(({ id }) => ({ id }))),
      },
    },
  };
});
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireAdminOrEditor: vi.fn(async () => ({ id: "u1", email: "u1@curf.local", tenantId: "t1", role: "developer" })) };
});
vi.mock("@/lib/rls", async () => {
  const { prisma } = await import("@/lib/db");
  return { withTenantContext: (_user: unknown, fn: (tx: unknown) => unknown) => fn(prisma) };
});
vi.mock("@/lib/billing", () => ({ requireReportQuota: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));

import { prisma } from "@/lib/db";
import { POST } from "./route";

const query = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, dataSourceId: "ds1", sql: "SELECT 1", ...extra });
const definition = (dataSources: unknown[]) => ({
  version: 1, name: "Imported", parameters: [], dataSources,
  pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks: [] }],
});
const importReport = (dataSources: unknown[], wiring: Record<string, string> = {}) =>
  POST(new NextRequest("http://localhost/api/reports/import", {
    method: "POST",
    body: JSON.stringify({ definition: definition(dataSources), wiring }),
  }));
const stored = () => JSON.parse(vi.mocked(prisma.report.create).mock.calls[0][0].data.definition);

beforeEach(() => vi.clearAllMocks());

describe("POST /api/reports/import — only this workspace's data sources", () => {
  it("refuses an ATTACH of another workspace's source, and creates nothing", async () => {
    const res = await importReport([query("q", { attaches: [{ dataSourceId: "ds-theirs", alias: "t" }] })]);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ dataSourceIds: ["ds-theirs"] });
    expect(vi.mocked(prisma.dataSource.findMany).mock.calls[0][0]).toMatchObject({ where: { tenantId: "t1" } });
    expect(prisma.report.create).not.toHaveBeenCalled();
  });

  it("imports an ATTACH of this workspace's source and a query wired to one", async () => {
    const res = await importReport(
      [query("q", { dataSourceId: "__placeholder__:sqlite_0", attaches: [{ dataSourceId: "ds1", alias: "t" }] })],
      { "__placeholder__:sqlite_0": "ds2" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "r-new" });
    expect(prisma.report.create).toHaveBeenCalledTimes(1);
    expect(stored().dataSources[0]).toMatchObject({ dataSourceId: "ds2", attaches: [{ dataSourceId: "ds1", alias: "t" }] });
  });
});
