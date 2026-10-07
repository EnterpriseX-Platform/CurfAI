import { describe, expect, it } from "vitest";
import { fill } from "./fill";

describe("fill", () => {
  it("replaces every placeholder, repeats included", () => expect(fill("{a} and {a} and {b}", { a: 1, b: "x" })).toBe("1 and 1 and x"));
  it("leaves unknown placeholders alone", () => expect(fill("{a} {zz}", { a: 1 })).toBe("1 {zz}"));
  it("does not re-expand inserted text", () => expect(fill("{a}", { a: "{a}" })).toBe("{a}"));
});
