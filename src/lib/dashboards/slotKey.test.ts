import { describe, it, expect } from "vitest";
import { slotKey, parseSlotKey, cardBlocks, findBlock, blockLabel } from "./slotKey";

const def = {
  pages: [
    { blocks: [{ id: "t", type: "title", config: { text: "Hi" } }, { id: "k1", type: "kpi", config: { label: "Revenue" } }] },
    { blocks: [{ id: "c1", type: "chart", config: { title: "Sales by month" } }, { id: "d", type: "divider" }, { id: "x", type: "table", config: {} }] },
  ],
};

describe("slot keys", () => {
  it("a whole report is its id, a block card adds the block after a #", () => {
    expect(slotKey("r1")).toBe("r1");
    expect(slotKey("r1", "k1")).toBe("r1#k1");
    expect(parseSlotKey("r1")).toEqual({ reportId: "r1", blockId: null });
    expect(parseSlotKey("r1#k1")).toEqual({ reportId: "r1", blockId: "k1" });
    expect(parseSlotKey("r1#")).toEqual({ reportId: "r1", blockId: null });
  });
  it("offers only blocks that show data, across pages, in order", () => {
    expect(cardBlocks(def).map((b) => b.id)).toEqual(["k1", "c1", "x"]);
    expect(cardBlocks(null)).toEqual([]);
  });
  it("finds a card block by id and not a heading", () => {
    expect(findBlock(def, "c1")?.type).toBe("chart");
    expect(findBlock(def, "t")).toBeNull();
    expect(findBlock(def, "nope")).toBeNull();
  });
  it("labels a block by its title or label, else its kind", () => {
    expect(blockLabel({ id: "k1", type: "kpi", config: { label: "Revenue" } })).toBe("Revenue");
    expect(blockLabel({ id: "c1", type: "chart", config: { title: " Sales by month " } })).toBe("Sales by month");
    expect(blockLabel({ id: "x", type: "table", config: {} })).toBe("table");
  });
});
