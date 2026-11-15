import { describe, it, expect } from "vitest";
import { auditInWords, AUDIT_WORD_VERBS, AUDIT_WORD_FAMILIES } from "./inWords";

describe("auditInWords", () => {
  it("builds the verb and thing keys from a known kind, folding past tense into the verb", () => {
    expect(auditInWords("report.create")).toEqual({ verb: "auditWords.verb.create", family: "auditWords.family.report" });
    expect(auditInWords("datasource.deleted")).toEqual({ verb: "auditWords.verb.delete", family: "auditWords.family.datasource" });
  });
  it("uses the last segment as the action, so a deeper kind still reads", () => {
    expect(auditInWords("lake.table.delete")).toEqual({ verb: "auditWords.verb.delete", family: "auditWords.family.lake" });
  });
  it("returns null for a kind it has no words for, so the page keeps the raw kind", () => {
    expect(auditInWords("report.explode")).toBeNull();
    expect(auditInWords("zzz.create")).toBeNull();
    expect(auditInWords("signin")).toBeNull();
  });
  it("exposes the lists the dictionary must cover", () => {
    expect(AUDIT_WORD_VERBS).toContain("create");
    expect(AUDIT_WORD_FAMILIES).toContain("report");
  });
});
