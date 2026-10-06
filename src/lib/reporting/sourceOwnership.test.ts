/**
 * A report definition was saved with whatever DataSource ids it carried, so
 * one could name another workspace's source and wait for someone (or a cron
 * tick) to run it. foreignSourceIds() is the save-time check: every query's
 * source and every ATTACHed source must be this workspace's; a placeholder
 * names none yet and passes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const OWN: Record<string, string[]> = { t1: ["ds-mine", "ds-excel"], t2: ["ds-theirs"] };

vi.mock("@/lib/db", () => ({
  prisma: {
    dataSource: {
      findMany: vi.fn(async ({ where }: any) =>
        (OWN[where.tenantId] ?? []).filter((id) => where.id.in.includes(id)).map((id) => ({ id }))),
    },
  },
}));

import { prisma } from "@/lib/db";
import { foreignSourceIds, foreignSourcesBlock } from "./sourceOwnership";

const q = (dataSourceId: string, attaches: string[] = []) => ({
  id: "q", name: "Q", dataSourceId, sql: "SELECT 1",
  ...(attaches.length ? { attaches: attaches.map((id, i) => ({ dataSourceId: id, alias: `a${i}` })) } : {}),
});

beforeEach(() => vi.clearAllMocks());

describe("foreignSourceIds", () => {
  it("is empty for a report that only names this workspace's sources", async () => {
    expect(await foreignSourceIds("t1", { dataSources: [q("ds-mine", ["ds-excel"])] })).toEqual([]);
    expect(vi.mocked(prisma.dataSource.findMany).mock.calls[0][0]).toMatchObject({ where: { tenantId: "t1" } });
  });

  it("names another workspace's source, in a query or in an ATTACH", async () => {
    expect(await foreignSourceIds("t1", { dataSources: [q("ds-theirs")] })).toEqual(["ds-theirs"]);
    expect(await foreignSourceIds("t1", { dataSources: [q("ds-mine", ["ds-theirs"])] })).toEqual(["ds-theirs"]);
  });

  it("treats an id that doesn't exist anywhere the same as another workspace's", async () => {
    expect(await foreignSourceIds("t1", { dataSources: [q("ds-nowhere")] })).toEqual(["ds-nowhere"]);
  });

  it("lets placeholders through, and doesn't query at all when nothing is named", async () => {
    expect(await foreignSourceIds("t1", { dataSources: [q("__placeholder__:sales", ["__placeholder__:kpis"])] })).toEqual([]);
    expect(prisma.dataSource.findMany).not.toHaveBeenCalled();
  });
});

describe("foreignSourcesBlock", () => {
  it("answers 400 with the offending ids, or null", async () => {
    const res = await foreignSourcesBlock("t1", { dataSources: [q("ds-mine"), q("ds-theirs")] });
    expect(res?.status).toBe(400);
    expect(await res!.json()).toMatchObject({ dataSourceIds: ["ds-theirs"] });
    expect(await foreignSourcesBlock("t1", { dataSources: [q("ds-mine")] })).toBeNull();
  });
});
