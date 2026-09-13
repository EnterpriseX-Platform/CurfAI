import { describe, it, expect } from "vitest";
import { rejectPathLikeName } from "./storage";

describe("rejectPathLikeName", () => {
  it("rejects a path-traversal filename (the pentest-reported case)", () => {
    expect(rejectPathLikeName("../../../etc/passwd")).toMatch(/path separators/);
  });

  it("rejects forward slashes, backslashes, and embedded null bytes", () => {
    expect(rejectPathLikeName("a/b")).not.toBeNull();
    expect(rejectPathLikeName("a\\b")).not.toBeNull();
    expect(rejectPathLikeName("a\0b")).not.toBeNull();
  });

  it("accepts a plain table name", () => {
    expect(rejectPathLikeName("mobile_sales_online_2560_2569")).toBeNull();
  });

  it("accepts names with spaces, dashes, and unicode", () => {
    expect(rejectPathLikeName("Sales 2024")).toBeNull();
    expect(rejectPathLikeName("ยอดขาย-รายเดือน")).toBeNull();
  });
});
