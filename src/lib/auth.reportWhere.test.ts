/**
 * Regression tests for reportWhere() — the Phase 3.2 scoped-API-key
 * variant of tenantWhere(). Every session user and unscoped key must get
 * IDENTICAL behavior to tenantWhere() alone; only a key minted with a
 * report allowlist should narrow further.
 */
import { describe, it, expect } from "vitest";
import { tenantWhere, reportWhere, parseScopedReportIds, requireReportInScope, type CurfSessionUser } from "./auth";

function user(overrides: Partial<CurfSessionUser> = {}): CurfSessionUser {
  return { id: "u1", email: "a@b.com", role: "viewer", tenantId: "t1", ...overrides };
}

describe("reportWhere", () => {
  it("matches tenantWhere exactly for a session user (no scopedReportIds field at all)", () => {
    const u = user();
    expect(reportWhere(u)).toEqual(tenantWhere(u));
    expect(reportWhere(u)).toEqual({ tenantId: "t1" });
  });

  it("matches tenantWhere exactly for an unscoped API key (viaApiKey true, scopedReportIds undefined)", () => {
    const u = user({ viaApiKey: true, apiKeyId: "k1" });
    expect(reportWhere(u)).toEqual({ tenantId: "t1" });
  });

  it("narrows to the allowlist for a scoped API key", () => {
    const u = user({ viaApiKey: true, apiKeyId: "k1", scopedReportIds: ["r1", "r2"] });
    expect(reportWhere(u)).toEqual({ tenantId: "t1", id: { in: ["r1", "r2"] } });
  });

  it("fails closed (matches zero rows) rather than open on a stray empty scopedReportIds array", () => {
    // The admin route never persists an empty allowlist (its own guard is
    // `scopedReportIds?.length ? ... : undefined`), so this shouldn't
    // happen in practice — but if it ever did, a scoping function should
    // fail closed, not silently widen back out to full tenant access.
    const u = user({ viaApiKey: true, apiKeyId: "k1", scopedReportIds: [] });
    expect(reportWhere(u)).toEqual({ tenantId: "t1", id: { in: [] } });
  });
});

describe("parseScopedReportIds", () => {
  // OWASP A10:2025 regression — a scoped key's allowlist column failing to
  // parse must never fall through to "unscoped" (full tenant access).
  it("returns undefined for an unset column (genuinely unscoped key)", () => {
    expect(parseScopedReportIds(null)).toBeUndefined();
    expect(parseScopedReportIds(undefined)).toBeUndefined();
    expect(parseScopedReportIds("")).toBeUndefined();
  });

  it("returns the parsed array for well-formed JSON", () => {
    expect(parseScopedReportIds('["r1","r2"]')).toEqual(["r1", "r2"]);
  });

  it("fails closed to an empty array on malformed JSON, not undefined", () => {
    expect(parseScopedReportIds("{not json")).toEqual([]);
    expect(parseScopedReportIds("undefined")).toEqual([]);
  });

  it("fails closed to an empty array when the JSON parses but isn't an array", () => {
    expect(parseScopedReportIds("{}")).toEqual([]);
    expect(parseScopedReportIds("null")).toEqual([]);
    expect(parseScopedReportIds('"r1"')).toEqual([]);
  });
});

describe("requireReportInScope", () => {
  // OWASP A01:2025 regression — the guard added to every
  // /api/reports/[id]/** route that couldn't use reportWhere() directly
  // (child-table lookups, hand-rolled tenant queries).
  it("passes (returns null) for a session user with no scopedReportIds field", () => {
    const u = user();
    expect(requireReportInScope(u, "r1")).toBeNull();
  });

  it("passes (returns null) for an unscoped API key", () => {
    const u = user({ viaApiKey: true, apiKeyId: "k1" });
    expect(requireReportInScope(u, "any-report-id")).toBeNull();
  });

  it("passes for a scoped key requesting a report inside its allowlist", () => {
    const u = user({ viaApiKey: true, apiKeyId: "k1", scopedReportIds: ["r1", "r2"] });
    expect(requireReportInScope(u, "r1")).toBeNull();
  });

  it("blocks with 404 for a scoped key requesting a report outside its allowlist", async () => {
    const u = user({ viaApiKey: true, apiKeyId: "k1", scopedReportIds: ["r1", "r2"] });
    const res = requireReportInScope(u, "r3-not-in-allowlist");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
    const body = await res!.json();
    expect(body.error).toBe("Not found");
  });

  it("blocks every report for a scoped key with an empty allowlist (fail closed)", () => {
    const u = user({ viaApiKey: true, apiKeyId: "k1", scopedReportIds: [] });
    const res = requireReportInScope(u, "r1");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });
});
