/**
 * The table cap counts the tables a workspace made. The retail pack's own
 * summary tables (nine after the first sales file) used to count too, so a
 * Community workspace (10 tables) was full after one file and the next
 * day's sales were refused (2026-09-30).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { tenant, lakeTable, lakeFileSize } = vi.hoisted(() => ({
  tenant: { findUnique: vi.fn() },
  lakeTable: { findMany: vi.fn() },
  lakeFileSize: vi.fn(() => 4096),
}));
vi.mock("@/lib/db", () => ({ prisma: { tenant, lakeTable } }));
vi.mock("./storage", () => ({ lakeFileSize }));

import { checkWriteAllowed, getUsageForTenant } from "./quota";

const own = (n: number) => Array.from({ length: n }, () => ({ sourceConfigJson: JSON.stringify({ filename: "sales.csv" }) }));
const summaries = (n: number) => Array.from({ length: n }, () => ({ sourceConfigJson: JSON.stringify({ provenance: "retail-metrics" }) }));

beforeEach(() => {
  vi.clearAllMocks();
  tenant.findUnique.mockResolvedValue({ tier: "community" });
});

describe("lake table cap", () => {
  it("counts the workspace's own tables, not the retail pack's summaries", async () => {
    lakeTable.findMany.mockResolvedValue([...own(1), ...summaries(9), { sourceConfigJson: null }, { sourceConfigJson: "not json" }]);
    expect(await getUsageForTenant("t1")).toEqual({ bytes: 4096, tables: 3 });
    expect(lakeTable.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
  });

  it("lets a Community workspace with one sales table and its nine summaries make another table", async () => {
    lakeTable.findMany.mockResolvedValue([...own(1), ...summaries(9)]);
    expect(await checkWriteAllowed({ tenantId: "t1", estimatedBytes: 2000, newTable: true })).toBeNull();
  });

  it("still refuses an eleventh table of the workspace's own, and only when the write makes one", async () => {
    lakeTable.findMany.mockResolvedValue([...own(10), ...summaries(9)]);
    expect(await checkWriteAllowed({ tenantId: "t1", newTable: true })).toMatch(/Lake table cap reached \(10\/10 on community\)/);
    expect(await checkWriteAllowed({ tenantId: "t1", estimatedBytes: 2000 })).toBeNull();
  });
});
