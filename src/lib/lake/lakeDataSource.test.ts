/**
 * FE-NB-07 (retest 2026-09-24): the lake source was found by NAME, so a
 * renamed one got a duplicate on the next publish, and a non-lake source
 * called "Curf Tables" had lake SQL bound to it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { rows, dataSource, counter } = vi.hoisted(() => {
  const rows: Array<{ id: string; tenantId: string; name: string; kind: string; createdAt: number }> = [];
  const counter = { seq: 0 };
  const dataSource = {
    findFirst: vi.fn(async ({ where }: any) => {
      const hit = rows.filter((r) => r.tenantId === where.tenantId && r.kind === where.kind).sort((a, b) => a.createdAt - b.createdAt)[0];
      return hit ? { id: hit.id } : null;
    }),
    create: vi.fn(async ({ data }: any) => {
      if (rows.some((r) => r.tenantId === data.tenantId && r.name === data.name)) throw new Error("Unique constraint failed on (tenantId, name)");
      const row = { id: `ds${++counter.seq}`, createdAt: counter.seq, ...data };
      rows.push(row);
      return { id: row.id };
    }),
  };
  return { rows, dataSource, counter };
});
vi.mock("@/lib/db", () => ({ prisma: { dataSource } }));

import { ensureLakeDataSource, findLakeDataSource } from "./lakeDataSource";

beforeEach(() => { rows.length = 0; counter.seq = 0; vi.clearAllMocks(); });

describe("ensureLakeDataSource", () => {
  it("creates the lake source when the workspace has none", async () => {
    const ds = await ensureLakeDataSource("t1");
    expect(rows).toEqual([expect.objectContaining({ id: ds.id, name: "Curf Tables", kind: "lake", connection: "lake://t1" })]);
  });

  it("finds a renamed lake source instead of creating a second one", async () => {
    rows.push({ id: "renamed", tenantId: "t1", name: "Budget lake", kind: "lake", createdAt: 0 });
    expect(await ensureLakeDataSource("t1")).toEqual({ id: "renamed" });
    expect(dataSource.create).not.toHaveBeenCalled();
  });

  it("never returns a non-lake source that happens to be called Curf Tables", async () => {
    rows.push({ id: "warehouse", tenantId: "t1", name: "Curf Tables", kind: "postgres", createdAt: 0 });
    const ds = await ensureLakeDataSource("t1");
    expect(ds.id).not.toBe("warehouse");
    expect(rows.find((r) => r.id === ds.id)).toMatchObject({ kind: "lake", name: "Curf Tables (lake)" });
  });

  it("only looks inside the given workspace", async () => {
    rows.push({ id: "other", tenantId: "t2", name: "Curf Tables", kind: "lake", createdAt: 0 });
    expect(await findLakeDataSource("t1")).toBeNull();
  });
});
