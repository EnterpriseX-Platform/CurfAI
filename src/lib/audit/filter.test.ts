import { describe, it, expect } from "vitest";
import { readAuditFilter, auditFilterWhere, auditFilterQuery } from "./filter";

const read = (q: Record<string, string>) => readAuditFilter((k) => q[k]);

describe("audit filters, shared by /admin/audit and its CSV export", () => {
  it("defaults to the last 7 days and ignores an unknown window", () => {
    expect(read({}).window).toBe("7d");
    expect(read({ window: "1y" }).window).toBe("7d");
  });

  it("an exact kind wins over its family, and a family holds the bare kind too", () => {
    expect(auditFilterWhere(read({ kind: "report.delete", family: "report", window: "all" }))).toEqual({ kind: "report.delete" });
    expect(auditFilterWhere(read({ family: "signin", window: "all" }))).toEqual({ OR: [{ kind: "signin" }, { kind: { startsWith: "signin." } }] });
  });

  it("filters person and target by substring and the window from now", () => {
    const now = Date.UTC(2026, 10, 12);
    const w = auditFilterWhere(read({ user: "maya", target: "rpt_1", window: "24h" }), now);
    expect(w).toEqual({ userEmail: { contains: "maya" }, target: { contains: "rpt_1" }, createdAt: { gte: new Date(now - 86_400_000) } });
  });

  it("carries the same filters into the export link", () => {
    expect(auditFilterQuery(read({ family: "report", user: "a@b.c", window: "30d" }))).toBe("family=report&user=a%40b.c&window=30d");
  });
});
