/**
 * Restoring a version wrote the stored definition back with whatever source
 * ids it carried, so a version saved before sources were checked on save
 * could bring back another workspace's data source. Now a version naming a
 * source outside the report's workspace is refused before anything is written.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ storedDefinition: "" }));

vi.mock("@/lib/db", () => {
  // As Postgres would answer { tenantId, id: { in } }: ds1/ds2 are t1's, ds-theirs is t2's.
  const sources = [{ id: "ds1", tenantId: "t1" }, { id: "ds2", tenantId: "t1" }, { id: "ds-theirs", tenantId: "t2" }];
  return {
    prisma: {
      report: {
        findFirst: vi.fn(async () => ({ id: "r1", tenantId: "t1", version: 3, definition: "{\"current\":true}" })),
        update: vi.fn(async () => ({ id: "r1", version: 4 })),
      },
      reportVersion: {
        findFirst: vi.fn(async () => ({ reportId: "r1", tenantId: "t1", version: 2, definition: h.storedDefinition })),
        create: vi.fn(async () => ({})),
      },
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
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));

import { prisma } from "@/lib/db";
import { POST } from "./route";

const query = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, dataSourceId: "ds1", sql: "SELECT 1", ...extra });
const definition = (dataSources: unknown[]) => JSON.stringify({
  version: 1, name: "R", parameters: [], dataSources,
  pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks: [] }],
});
const restore = () =>
  POST(new NextRequest("http://localhost/api/reports/r1/versions/2/restore", { method: "POST" }), {
    params: { id: "r1", version: "2" },
  });

beforeEach(() => vi.clearAllMocks());

describe("POST /api/reports/:id/versions/:version/restore — only this workspace's data sources", () => {
  it("refuses a stored version whose query names another workspace's source, and writes nothing", async () => {
    h.storedDefinition = definition([query("q", { dataSourceId: "ds-theirs" })]);
    const res = await restore();
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ dataSourceIds: ["ds-theirs"] });
    expect(vi.mocked(prisma.dataSource.findMany).mock.calls[0][0]).toMatchObject({ where: { tenantId: "t1" } });
    expect(prisma.report.update).not.toHaveBeenCalled();
    expect(prisma.reportVersion.create).not.toHaveBeenCalled();
  });

  it("refuses a stored version that ATTACHes another workspace's source", async () => {
    h.storedDefinition = definition([query("q", { attaches: [{ dataSourceId: "ds-theirs", alias: "t" }] })]);
    const res = await restore();
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ dataSourceIds: ["ds-theirs"] });
    expect(prisma.report.update).not.toHaveBeenCalled();
    expect(prisma.reportVersion.create).not.toHaveBeenCalled();
  });

  it("restores a version naming only this workspace's sources and a placeholder", async () => {
    h.storedDefinition = definition([
      query("q1", { attaches: [{ dataSourceId: "ds2", alias: "t" }] }),
      query("q2", { dataSourceId: "__placeholder__:sales_db" }),
    ]);
    const res = await restore();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "r1", version: 4, restoredFrom: 2 });
    expect(prisma.reportVersion.create).toHaveBeenCalledTimes(1);
    expect(prisma.report.update).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prisma.report.update).mock.calls[0][0]).toMatchObject({ data: { definition: h.storedDefinition } });
  });
});
