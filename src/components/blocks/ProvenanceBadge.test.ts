/**
 * The proof badge used to wear a green "Verified" seal on EVERY query — including
 * one that failed, which the runner hands back as an empty result with the reason
 * in provenance.executionError. A "$0.00" next to a verified tick is a proof of
 * nothing. The seal may only claim what happened: this pins the state logic and
 * the trigger it renders (the popover content is checked in the browser).
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProvenanceBadge } from "./ProvenanceBadge";
import type { ProvenanceRecord } from "@/lib/reporting/provenance";
import { queryRunState } from "@/lib/reporting/queryRunState";

const record = (over: Partial<ProvenanceRecord> = {}): ProvenanceRecord => ({
  queryId: "q", queryName: "Churn", queryHash: "a".repeat(64), dataHash: "b".repeat(64),
  runAt: "2026-09-19T10:00:00.000Z", durationMs: 12, rowCount: 3,
  dataSourceName: "Curf Tables", dataSourceKind: "lake",
  ...over,
} as ProvenanceRecord);

const markup = (r: ProvenanceRecord, variant: "icon" | "seal" = "seal") =>
  renderToStaticMarkup(createElement(ProvenanceBadge, { record: r, variant }));

describe("queryRunState", () => {
  it("is verified for a query that ran — including one that returned no rows", () => {
    expect(queryRunState(record())).toEqual({ kind: "ran" });
    expect(queryRunState(record({ rowCount: 0 }))).toEqual({ kind: "ran" });
  });

  it("is failed, with the reason, when the query threw", () => {
    expect(queryRunState(record({ executionError: "Binder Error: no such column" })))
      .toEqual({ kind: "failed", reason: "Binder Error: no such column" });
  });

  it("is restricted, with the note, when the viewer can't see the source", () => {
    expect(queryRunState(record({ accessDeniedNote: "Hidden by visibility" })))
      .toEqual({ kind: "restricted", reason: "Hidden by visibility" });
  });

  it("a failure wins over an access note", () => {
    expect(queryRunState(record({ executionError: "boom", accessDeniedNote: "hidden" })).kind).toBe("failed");
  });
});

describe("ProvenanceBadge trigger", () => {
  it("a verified query keeps the green seal and the provenance label", () => {
    const html = markup(record());
    expect(html).toContain('aria-label="View provenance"');
    expect(html).toContain("border-success");
    expect(html).not.toContain("destructive");
  });

  it("a failed query does NOT wear the verified seal, and says it didn't run", () => {
    const html = markup(record({ executionError: "boom" }));
    expect(html).not.toContain("border-success");
    expect(html).not.toContain('aria-label="View provenance"');
    expect(html).toContain("This query didn&#x27;t run");
    expect(html).toContain("border-destructive");
  });

  it("a restricted query is marked as a warning, not verified", () => {
    const html = markup(record({ accessDeniedNote: "Hidden by visibility" }));
    expect(html).not.toContain("border-success");
    expect(html).toContain("restricted");
    expect(html).toContain("border-warning");
  });

  it("the icon variant of a failure is always visible — the hover-only reveal is for a verified tick", () => {
    const verified = markup(record(), "icon");
    const failed = markup(record({ executionError: "boom" }), "icon");
    expect(verified).toContain("opacity-0");
    expect(failed).not.toContain("opacity-0");
    expect(failed).not.toContain("no-print"); // and it prints: a printed report shouldn't hide that a block failed
  });
});
