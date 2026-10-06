import { describe, expect, it } from "vitest";
import { initials } from "./utils";

describe("initials", () => {
  it("takes the first letters of a name's first two words", () => {
    expect(initials("Maya Okafor")).toBe("MO");
    expect(initials("Demo Workspace")).toBe("DW");
  });
  it("reads an email by its local part", () => {
    expect(initials("nok.srisuk@northwind.example")).toBe("NS");
    expect(initials("admin@curf.local")).toBe("AD");
  });
  it("uses two letters of a single word, and never returns nothing", () => {
    expect(initials("Admin")).toBe("AD");
    expect(initials("  ")).toBe("?");
  });
});
