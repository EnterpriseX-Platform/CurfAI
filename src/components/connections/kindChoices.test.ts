import { describe, it, expect } from "vitest";
import { kindGroups } from "./kindChoices";

describe("kindGroups", () => {
  it("groups every kind by what the person has in hand", () => {
    const g = kindGroups(() => true);
    expect(g.map((x) => x.id)).toEqual(["file", "database", "warehouse", "app", "engine"]);
    expect(g.find((x) => x.id === "app")!.choices.map((c) => c.kind)).toEqual(["rest", "hubspot", "zendesk"]);
  });
  it("leaves out kinds the form may not offer, and a group left empty", () => {
    const g = kindGroups((k) => k === "excel" || k === "rest");
    expect(g.map((x) => x.id)).toEqual(["file", "app"]);
    expect(g[0].choices.map((c) => c.kind)).toEqual(["excel"]);
  });
  it("names a label and a hint key for each choice", () => {
    const c = kindGroups(() => true)[0].choices[0];
    expect(c.labelKey).toBe("connectionForm.choose.excel");
    expect(c.hintKey).toBe("connectionForm.choose.excel.hint");
  });
});
