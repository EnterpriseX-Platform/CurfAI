/**
 * Found live during a Tables 2.0 adversarial-SQL edge-case pass
 * (2026-09-20): editing a materialized view's SQL to anything the
 * read-only-SELECT guard rejects (a stray second statement, an
 * accidental DDL/DML line — or a deliberate injection attempt; the
 * guard correctly blocks all of them either way) crashed
 * POST /api/lake/materialized-views/[id] with an uncaught ZodError and
 * an empty 500, instead of the normal "this MV failed to refresh, here's
 * why" result every OTHER failure mode in refreshMaterializedView()
 * already returns (a bad query, a lake write failure, a governance
 * lookup failure). Root cause: ReportSchema.parse() — where that guard
 * lives — ran before the function's own try/catch instead of inside it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ mv: null as any }));

vi.mock("@/lib/db", () => ({
  prisma: {
    materializedView: {
      findUnique: vi.fn(async () => h.mv),
      update: vi.fn(async ({ data }: any) => ({ ...h.mv, ...data })),
    },
  },
}));
vi.mock("@/lib/reporting/runQueryStrict", () => ({ runQueryStrict: vi.fn() }));
vi.mock("@/lib/lake/tables", () => ({ createOrReplaceTable: vi.fn() }));
vi.mock("@/lib/lake/sourceGovernance", () => ({
  governDerivedColumns: vi.fn(),
  governDerivedTableAcl: vi.fn(),
  loadDerivationSources: vi.fn(),
}));
vi.mock("@/lib/lake/storage", () => ({
  lakeFileSize: vi.fn(() => 0),
  toSafeTableName: (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
}));
vi.mock("@/lib/webhooks", () => ({ emitWebhook: vi.fn() }));
vi.mock("@/lib/lake/bust", () => ({ bustLakeCacheForTenant: vi.fn() }));

import { prisma } from "@/lib/db";
import { runQueryStrict } from "@/lib/reporting/runQueryStrict";
import { emitWebhook } from "@/lib/webhooks";
import { refreshMaterializedView } from "./materialize";

beforeEach(() => {
  vi.clearAllMocks();
  h.mv = {
    id: "mv1", tenantId: "t1", name: "Bad View", sql: "DROP TABLE banking_branches",
    dataSourceId: "ds1", enabled: true,
  };
});

describe("refreshMaterializedView — SQL the read-only guard rejects", () => {
  it.each([
    ["a bare DDL statement", "DROP TABLE banking_branches"],
    ["a stacked statement after a semicolon", "SELECT 1; DROP TABLE banking_branches; --"],
    ["DML", "DELETE FROM banking_branches"],
  ])("returns a structured failure instead of throwing, for %s", async (_label, sql) => {
    h.mv.sql = sql;
    const result = await refreshMaterializedView("mv1");

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/read-only SELECT/);
    expect(runQueryStrict).not.toHaveBeenCalled();
  });

  it("records lastStatus: failed on the MV row, same as a query-execution failure would", async () => {
    await refreshMaterializedView("mv1");
    expect(prisma.materializedView.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "mv1" },
        data: expect.objectContaining({ lastStatus: "failed", lastError: expect.stringMatching(/read-only SELECT/) }),
      }),
    );
  });

  it("emits the same lake.mv.failed webhook a query-execution failure would", async () => {
    await refreshMaterializedView("mv1");
    expect(emitWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "t1", event: "lake.mv.failed" }),
    );
  });
});
