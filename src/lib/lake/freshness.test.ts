import { describe, it, expect } from "vitest";
import { freshnessIssueFor, emptyFreshnessMaps, type FreshnessMaps } from "./freshness";

function maps(overrides: Partial<FreshnessMaps>): FreshnessMaps {
  return { ...emptyFreshnessMaps(), ...overrides };
}

describe("freshnessIssueFor", () => {
  it("returns null for upload/webhook/plain-manual — no schedule to report on", () => {
    expect(freshnessIssueFor("t", "upload", { filename: "a.csv" }, emptyFreshnessMaps())).toBeNull();
    expect(freshnessIssueFor("t", "webhook", { label: "x" }, emptyFreshnessMaps())).toBeNull();
    expect(freshnessIssueFor("t", "manual", null, emptyFreshnessMaps())).toBeNull();
  });

  it("returns null when the maps have no matching entry at all", () => {
    expect(freshnessIssueFor("orders", "manual", { kind: "cdc" }, emptyFreshnessMaps())).toBeNull();
  });

  describe("CDC", () => {
    it("is null when the subscription has no error", () => {
      const m = maps({ cdcSubs: new Map([["orders", { lastRunAt: "2026-01-01T00:00:00Z", lastStatus: "ok", lastError: null }]]) });
      expect(freshnessIssueFor("orders", "manual", { kind: "cdc" }, m)).toBeNull();
    });

    it("surfaces the error, keyed by the table's own name", () => {
      const m = maps({ cdcSubs: new Map([["orders", { lastRunAt: "2026-01-01T00:00:00Z", lastStatus: "failed", lastError: "connection refused" }]]) });
      expect(freshnessIssueFor("orders", "manual", { kind: "cdc" }, m)).toEqual({ error: "connection refused", lastAttemptAt: "2026-01-01T00:00:00Z" });
    });
  });

  describe("materialized view", () => {
    it("is null when the mv refreshed ok", () => {
      const m = maps({ materializedViews: new Map([["mv1", { lastRunAt: null, lastStatus: "ok", lastError: null }]]) });
      expect(freshnessIssueFor("daily_revenue", "manual", { kind: "materialized_view", mvId: "mv1" }, m)).toBeNull();
    });

    it("surfaces a failed refresh", () => {
      const m = maps({ materializedViews: new Map([["mv1", { lastRunAt: "2026-02-01T00:00:00Z", lastStatus: "failed", lastError: "syntax error near GROUP" }]]) });
      expect(freshnessIssueFor("daily_revenue", "manual", { kind: "materialized_view", mvId: "mv1" }, m))
        .toEqual({ error: "syntax error near GROUP", lastAttemptAt: "2026-02-01T00:00:00Z" });
    });

    it("is null without an mvId to look up", () => {
      expect(freshnessIssueFor("daily_revenue", "manual", { kind: "materialized_view" }, emptyFreshnessMaps())).toBeNull();
    });
  });

  describe("sync connectors", () => {
    it("keys the lookup by connectionId|sourceObject", () => {
      const m = maps({ syncCursors: new Map([["conn1|Opportunity", { lastRunAt: "2026-03-01T00:00:00Z", lastError: "INVALID_SESSION_ID" }]]) });
      const result = freshnessIssueFor("salesforce_opportunity", "manual", { provenance: "sync", connectionId: "conn1", sourceObject: "Opportunity" }, m);
      expect(result).toEqual({ error: "INVALID_SESSION_ID", lastAttemptAt: "2026-03-01T00:00:00Z" });
    });

    it("is null when the cursor has no error", () => {
      const m = maps({ syncCursors: new Map([["conn1|Opportunity", { lastRunAt: "2026-03-01T00:00:00Z", lastError: null }]]) });
      expect(freshnessIssueFor("salesforce_opportunity", "manual", { provenance: "sync", connectionId: "conn1", sourceObject: "Opportunity" }, m)).toBeNull();
    });
  });

  describe("scheduled pulls", () => {
    it("surfaces a failed REST pull by pullId", () => {
      const m = maps({ pulls: new Map([["pull1", { lastRunAt: "2026-04-01T00:00:00Z", lastStatus: "failed", lastError: "403 from upstream" }]]) });
      expect(freshnessIssueFor("stripe_invoices", "rest_pull", { pullId: "pull1" }, m))
        .toEqual({ error: "403 from upstream", lastAttemptAt: "2026-04-01T00:00:00Z" });
    });

    it("applies the same lookup to sftp_pull", () => {
      const m = maps({ pulls: new Map([["pull2", { lastRunAt: null, lastStatus: "failed", lastError: "auth failed" }]]) });
      expect(freshnessIssueFor("gl_export", "sftp_pull", { pullId: "pull2" }, m)?.error).toBe("auth failed");
    });

    it("is null for a skipped (not failed) pull", () => {
      const m = maps({ pulls: new Map([["pull1", { lastRunAt: "2026-04-01T00:00:00Z", lastStatus: "skipped", lastError: null }]]) });
      expect(freshnessIssueFor("stripe_invoices", "rest_pull", { pullId: "pull1" }, m)).toBeNull();
    });
  });
});
