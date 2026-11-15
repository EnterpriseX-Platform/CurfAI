import { describe, it, expect } from "vitest";
import { profilePreview, filledPercent } from "./previewProfile";

describe("profilePreview", () => {
  const rows = [
    { sku: "A", note: "", qty: 1, tags: ["x"] },
    { sku: "B", note: null, qty: 1, tags: ["x"] },
    { sku: "A", note: "hi", qty: 0, tags: ["y"] },
    { sku: "C", qty: 2, tags: ["x"] },
  ];
  it("counts filled and distinct values per column, treating null, missing and blank as empty and zero as a value", () => {
    const p = profilePreview(rows, ["sku", "note", "qty", "tags", "absent"]);
    expect(p.get("sku")).toEqual({ rows: 4, filled: 4, distinct: 3 });
    expect(p.get("note")).toEqual({ rows: 4, filled: 1, distinct: 1 });
    expect(p.get("qty")).toEqual({ rows: 4, filled: 4, distinct: 3 });
    expect(p.get("tags")).toEqual({ rows: 4, filled: 4, distinct: 2 });
    expect(p.get("absent")).toEqual({ rows: 4, filled: 0, distinct: 0 });
  });
  it("words the filled share, and a dash when there are no rows", () => {
    expect(filledPercent({ rows: 4, filled: 3, distinct: 2 })).toBe("75%");
    expect(filledPercent(profilePreview([], ["a"]).get("a"))).toBe("–");
    expect(filledPercent(undefined)).toBe("–");
  });
});
