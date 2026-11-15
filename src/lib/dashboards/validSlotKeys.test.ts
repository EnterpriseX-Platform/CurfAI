import { describe, it, expect, vi } from "vitest";

const findMany = vi.fn();
vi.mock("@/lib/db", () => ({ prisma: { report: { findMany: (a: any) => findMany(a) } } }));

import { validSlotKeys } from "./validSlotKeys";

const def = JSON.stringify({ pages: [{ blocks: [{ id: "k1", type: "kpi", config: {} }, { id: "t1", type: "title", config: {} }] }] });

describe("validSlotKeys", () => {
  it("keeps this workspace's reports and the blocks still in them, in the order given", async () => {
    findMany.mockResolvedValue([{ id: "r1", definition: def }, { id: "r2", definition: "{}" }]);
    const out = await validSlotKeys("t1", ["r2", "r1#k1", "r1", "r1#gone", "r1#t1", "other", "other#k1"]);
    // r1#gone no longer exists; r1#t1 is a heading, not a card; "other" is not this workspace's.
    expect(out).toEqual(["r2", "r1#k1", "r1"]);
  });
  it("asks only for this workspace's reports, each once", async () => {
    findMany.mockResolvedValue([]);
    await validSlotKeys("ws", ["a#x", "a#y", "b"]);
    const where = findMany.mock.calls.at(-1)![0].where;
    expect(where.tenantId).toBe("ws");
    expect(where.id.in).toEqual(["a", "b"]);
  });
  it("treats a definition that cannot be read as having no such block", async () => {
    findMany.mockResolvedValue([{ id: "r1", definition: "not json" }]);
    expect(await validSlotKeys("t1", ["r1#k1", "r1"])).toEqual(["r1"]);
  });
});
