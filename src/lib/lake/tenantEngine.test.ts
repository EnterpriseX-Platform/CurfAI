import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: { tenant: { findUnique } } }));

import { tenantLakeEngine } from "./tenantEngine";

beforeEach(() => { findUnique.mockReset(); });

describe("tenantLakeEngine", () => {
  it("is duckdb for a migrated tenant, and looks up only that tenant", async () => {
    findUnique.mockResolvedValue({ lakeEngine: "duckdb" });
    await expect(tenantLakeEngine("t1")).resolves.toBe("duckdb");
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "t1" }, select: { lakeEngine: true } });
  });

  it("is sqlite for the default, for an unset column, for an unknown value, and for a missing tenant", async () => {
    for (const row of [{ lakeEngine: "sqlite" }, { lakeEngine: null }, { lakeEngine: "something-else" }, null]) {
      findUnique.mockResolvedValue(row);
      await expect(tenantLakeEngine("t1")).resolves.toBe("sqlite");
    }
  });

  it("falls back to sqlite rather than throwing when the lookup fails (e.g. a schema without the column)", async () => {
    findUnique.mockRejectedValue(new Error("column does not exist"));
    await expect(tenantLakeEngine("t1")).resolves.toBe("sqlite");
  });
});
