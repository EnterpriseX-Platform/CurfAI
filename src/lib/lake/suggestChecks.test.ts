import { describe, it, expect } from "vitest";
import { suggestChecks } from "./suggestChecks";
import { profilePreview } from "./previewProfile";

const rows = Array.from({ length: 12 }, (_, i) => ({ order_id: `O${i}`, branch: i % 3 ? "A" : "B", note: i % 2 ? "x" : "", amount: i }));
const cols = ["order_id", "branch", "note", "amount"];
const profile = profilePreview(rows, cols);

describe("suggestChecks", () => {
  it("proposes a minimum row count, a key to be unique, and full columns to never be empty", () => {
    const s = suggestChecks(cols, profile, 1000, []);
    expect(s).toContainEqual({ kind: "row_count_min", min: 500 });
    expect(s).toContainEqual({ kind: "unique", column: "order_id" });
    expect(s).toContainEqual({ kind: "not_null", column: "order_id" });
    expect(s).toContainEqual({ kind: "not_null", column: "amount" });
    expect(s).not.toContainEqual({ kind: "not_null", column: "note" });
    expect(s).not.toContainEqual({ kind: "unique", column: "amount" });
  });
  it("does not propose a check the workspace already has", () => {
    const s = suggestChecks(cols, profile, 1000, [
      { kind: "not_null", configJson: '{"column":"order_id"}' },
      { kind: "row_count_min", configJson: '{"min":1}' },
    ]);
    expect(s).not.toContainEqual({ kind: "not_null", column: "order_id" });
    expect(s.some((x) => x.kind === "row_count_min")).toBe(false);
    expect(s).toContainEqual({ kind: "unique", column: "order_id" });
  });
  it("proposes nothing about columns from a sample that is too small", () => {
    const small = profilePreview(rows.slice(0, 4), cols);
    expect(suggestChecks(cols, small, 4, []).every((x) => x.kind === "row_count_min")).toBe(true);
  });
  it("proposes nothing for an empty table", () => {
    expect(suggestChecks(cols, profilePreview([], cols), 0, [])).toEqual([]);
  });
});
