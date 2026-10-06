/**
 * The runner looked up every DataSource a report names by id alone, so a
 * report whose definition named another workspace's source id read that
 * workspace's data. Inside a request, Postgres row-level security stopped it;
 * a cron tick or other system context has no workspace bound, so a scheduled
 * delivery or watcher read the other workspace. Every lookup is now scoped to
 * the report's own workspace (RunContext.tenantId), and a source from another
 * one fails as "DataSource not found", the same as one that doesn't exist.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  rows: {
    "ds-mine": { id: "ds-mine", tenantId: "t1", name: "mine", kind: "sqlite", connection: "file:unused.db", ownerUserId: null, visibleToRolesJson: "[]" },
    "ds-theirs": { id: "ds-theirs", tenantId: "t2", name: "theirs", kind: "sqlite", connection: "file:unused.db", ownerUserId: null, visibleToRolesJson: "[]" },
  } as Record<string, any>,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    dataSource: {
      // As Postgres would answer { id, tenantId }: another workspace's row isn't there.
      findFirst: vi.fn(async ({ where }: any) => (h.rows[where.id]?.tenantId === where.tenantId ? h.rows[where.id] : null)),
    },
  },
}));

import { prisma } from "@/lib/db";
import { runReportWithProof, runSingleQuery, SYSTEM_RUN } from "./runner";

const report = (dataSources: any[]) => ({
  version: 1, name: "Probe", parameters: [], dataSources,
  pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks: [] }],
}) as any;

beforeEach(() => vi.clearAllMocks());

describe("runner — a report only reaches its own workspace's sources", () => {
  it("a query naming another workspace's source fails as not found, looked up inside the report's workspace", async () => {
    await expect(runReportWithProof({
      report: report([{ id: "q", name: "Q", dataSourceId: "ds-theirs", sql: "SELECT 1" }]),
      params: {}, tenantId: "t1", viewer: SYSTEM_RUN,
    })).rejects.toThrow("DataSource not found: ds-theirs");
    expect(vi.mocked(prisma.dataSource.findFirst).mock.calls[0][0]).toEqual({ where: { id: "ds-theirs", tenantId: "t1" } });
  });

  it("an ATTACH of another workspace's source is refused before anything opens", async () => {
    const { dataset, provenance } = await runReportWithProof({
      report: report([{ id: "q", name: "Q", dataSourceId: "ds-mine", sql: "SELECT 1", attaches: [{ dataSourceId: "ds-theirs", alias: "t" }] }]),
      params: {}, tenantId: "t1", viewer: SYSTEM_RUN,
    });
    expect(dataset.q).toEqual([]);
    expect(provenance.q.accessDeniedNote).toBe('Attached source "t" is missing or belongs to another tenant.');
  });

  it("runSingleQuery refuses another workspace's source, and an ATTACH of one", async () => {
    await expect(runSingleQuery({ id: "q", name: "Q", dataSourceId: "ds-theirs", sql: "SELECT 1" }, {}, SYSTEM_RUN, "t1"))
      .rejects.toThrow("DataSource not found: ds-theirs");
    await expect(runSingleQuery(
      { id: "q", name: "Q", dataSourceId: "ds-mine", sql: "SELECT 1", attaches: [{ dataSourceId: "ds-theirs", alias: "t" }] },
      {}, SYSTEM_RUN, "t1",
    )).rejects.toThrow('Attached source "t" is missing or belongs to another tenant.');
  });
});
