import { describe, expect, it } from "vitest";
import { barsHorizontal, isSequenceAxis } from "./barOrientation";

const names = ["Bangkok", "Chiang Mai", "Khon Kaen", "Phuket", "Hat Yai", "Udon Thani", "Nakhon Ratchasima", "Pattaya", "Surat Thani"];

describe("barsHorizontal", () => {
  it("lies more than eight named categories down", () => {
    expect(barsHorizontal(undefined, names)).toBe(true);
    expect(barsHorizontal(undefined, names.slice(0, 8))).toBe(false);
  });
  it("keeps the author's explicit choice", () => {
    expect(barsHorizontal("vertical", names)).toBe(false);
    expect(barsHorizontal("horizontal", ["A", "B"])).toBe(true);
  });
  it("keeps a time or number axis upright however long", () => {
    const weeks = Array.from({ length: 12 }, (_, i) => `2026-W${String(i + 20).padStart(2, "0")}`);
    const months = Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, "0")}`);
    expect(barsHorizontal(undefined, weeks)).toBe(false);
    expect(barsHorizontal(undefined, months)).toBe(false);
    expect(barsHorizontal(undefined, Array.from({ length: 24 }, (_, h) => h))).toBe(false);
    expect(barsHorizontal(undefined, ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct"])).toBe(false);
    expect(barsHorizontal(undefined, ["ต.ค. 68", "พ.ย. 68", "ธ.ค. 68", "ม.ค. 69", "ก.พ. 69", "มี.ค. 69", "เม.ย. 69", "พ.ค. 69", "มิ.ย. 69"])).toBe(false);
  });
});

describe("isSequenceAxis", () => {
  it("tells sequences from names", () => {
    expect(isSequenceAxis(["2026-01-03", "2026-01-09", "2026-02-20"])).toBe(true);
    expect(isSequenceAxis(["2026-Q1", "2026-Q2"])).toBe(true);
    expect(isSequenceAxis(names)).toBe(false);
    expect(isSequenceAxis([])).toBe(false);
  });
});
