import { describe, it, expect } from "vitest";
import { sameSitePath } from "./safePath";

describe("sameSitePath", () => {
  it("keeps a path on this site, with its query", () => {
    expect(sameSitePath("/reports/r1?view=v2")).toBe("/reports/r1?view=v2");
    expect(sameSitePath("/")).toBe("/");
  });

  it("falls back for anything that could leave the site", () => {
    for (const v of ["https://example.com", "//example.com", "/\\example.com", "/\texample.com", "javascript:alert(1)", "example.com", ""]) {
      expect(sameSitePath(v)).toBe("/");
    }
    expect(sameSitePath(null)).toBe("/");
    expect(sameSitePath(undefined, "/home")).toBe("/home");
  });
});
