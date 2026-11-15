import { describe, it, expect } from "vitest";
import { repointCards } from "./repoint";

const base = { fromId: "old", toId: "new" };

describe("repointCards", () => {
  it("moves a whole-report card to the new id and keeps other reports alone", () => {
    const r = repointCards({ ...base, reportIdsJson: '["old","other"]', slotLayoutJson: '{"old":{"x":0},"other":{"x":6}}', hasBlock: () => false });
    expect(JSON.parse(r.reportIdsJson)).toEqual(["new", "other"]);
    expect(JSON.parse(r.slotLayoutJson)).toEqual({ new: { x: 0 }, other: { x: 6 } });
    expect(r.fellBack).toBe(0);
  });
  it("keeps a block card's block when the new design still has it", () => {
    const r = repointCards({ ...base, reportIdsJson: '["old#k1"]', slotLayoutJson: '{"old#k1":{"x":3}}', hasBlock: (b) => b === "k1" });
    expect(JSON.parse(r.reportIdsJson)).toEqual(["new#k1"]);
    expect(JSON.parse(r.slotLayoutJson)).toEqual({ "new#k1": { x: 3 } });
    expect(r.fellBack).toBe(0);
  });
  it("falls back to the whole new report when the block is gone, once, and counts it", () => {
    const r = repointCards({ ...base, reportIdsJson: '["old#a","old#b","new"]', slotLayoutJson: "{}", hasBlock: () => false });
    expect(JSON.parse(r.reportIdsJson)).toEqual(["new"]);
    expect(r.fellBack).toBe(2);
  });
  it("leaves what it cannot read exactly as it was", () => {
    const r = repointCards({ ...base, reportIdsJson: "not json", slotLayoutJson: null, hasBlock: () => true });
    expect(r.reportIdsJson).toBe("not json");
    expect(r.slotLayoutJson).toBe("");
  });
});
