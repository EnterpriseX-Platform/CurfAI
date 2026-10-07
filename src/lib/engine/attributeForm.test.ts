import { describe, it, expect } from "vitest";
import { addValues, checkEdit, diffValues, removeValue, splitValueInput, suggestNames, validateName, validateValue, validateValues } from "./attributeForm";

describe("attribute form", () => {
  it("splits typed values on lines and commas, trimming and dropping repeats", () => {
    expect(splitValueInput(" A001, A002\nA001\r\n\n  ,B ")).toEqual(["A001", "A002", "B"]);
    expect(splitValueInput("   ")).toEqual([]);
  });
  it("adds only new values and removes one", () => {
    expect(addValues(["A"], "A, B")).toEqual(["A", "B"]);
    expect(removeValue(["A", "B"], "A")).toEqual(["B"]);
  });
  it("validates names like the server", () => {
    expect(validateName("")?.code).toBe("nameRequired");
    expect(validateName("1abc")?.code).toBe("nameInvalid");
    expect(validateName("agency-code")?.code).toBe("nameInvalid");
    expect(validateName("a".repeat(65))?.code).toBe("nameInvalid");
    expect(validateName(" agency_code ")).toBeNull();
    expect(validateName("a".repeat(64))).toBeNull();
  });
  it("validates values", () => {
    expect(validateValue("x".repeat(200))).toBeNull();
    expect(validateValue("x".repeat(201))?.code).toBe("valueTooLong");
    expect(validateValue("a\u0007")?.code).toBe("valueControl");
    expect(validateValues(Array.from({ length: 1001 }, (_, i) => `v${i}`))?.code).toBe("tooManyValues");
    expect(validateValues(Array.from({ length: 1000 }, (_, i) => `v${i}`))).toBeNull();
  });
  it("checks a whole edit; an empty list is allowed", () => {
    expect(checkEdit({ name: " region ", values: [] })).toEqual({ ok: true, name: "region", values: [] });
    const bad = checkEdit({ name: "", values: ["x".repeat(201)] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) { expect(bad.name?.code).toBe("nameRequired"); expect(bad.values?.code).toBe("valueTooLong"); }
  });
  it("suggests known names by prefix, not the exact one", () => {
    expect(suggestNames(["agency_code", "Region", "area"], "a")).toEqual(["agency_code", "area"]);
    expect(suggestNames(["agency_code"], "agency_code")).toEqual([]);
    expect(suggestNames(["a", "b"], "")).toEqual(["a", "b"]);
  });
  it("diffs values", () => {
    expect(diffValues(["a", "b"], ["b", "c"])).toEqual({ added: ["c"], removed: ["a"] });
  });
});
