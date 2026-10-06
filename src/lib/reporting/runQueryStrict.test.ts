/**
 * runQueryStrict is for code that PERSISTS what a report query returns. The
 * runner reports a failed query as an empty array with the reason in
 * provenance, which is right for display and indistinguishable from "no rows"
 * for a writer — see the module's header for what that cost.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ result: null as any, ctxSeen: null as any }));
vi.mock("./runner", () => ({
  runReportWithProof: vi.fn(async (ctx: any) => { h.ctxSeen = ctx; return h.result; }),
}));

import { runQueryStrict } from "./runQueryStrict";

const ctx = { report: { name: "r" } as any, params: { a: 1 }, tenantId: "t1", viewer: "system" as const };

beforeEach(() => { h.result = null; h.ctxSeen = null; });

describe("runQueryStrict", () => {
  it("returns the query's rows, and runs exactly the context it was given", async () => {
    h.result = { dataset: { q: [{ a: 1 }, { a: 2 }] }, provenance: { q: {} } };
    await expect(runQueryStrict(ctx, "q")).resolves.toEqual([{ a: 1 }, { a: 2 }]);
    expect(h.ctxSeen).toBe(ctx);
  });

  it("returns an empty array for a query that genuinely returned no rows", async () => {
    h.result = { dataset: { q: [] }, provenance: { q: {} } };
    await expect(runQueryStrict(ctx, "q")).resolves.toEqual([]);
  });

  it("throws the runner's reason when the query failed, instead of returning the empty array it leaves behind", async () => {
    h.result = { dataset: { q: [] }, provenance: { q: { executionError: "Binder Error: no such column: nope" } } };
    await expect(runQueryStrict(ctx, "q")).rejects.toThrow("Binder Error: no such column: nope");
  });

  it("throws when the query was skipped for access reasons", async () => {
    h.result = { dataset: { q: [] }, provenance: { q: { accessDeniedNote: "Hidden by visibility" } } };
    await expect(runQueryStrict(ctx, "q")).rejects.toThrow("Hidden by visibility");
  });

  it("only looks at the query it was asked for", async () => {
    h.result = {
      dataset: { good: [{ a: 1 }], bad: [] },
      provenance: { good: {}, bad: { executionError: "boom" } },
    };
    await expect(runQueryStrict(ctx, "good")).resolves.toEqual([{ a: 1 }]);
    await expect(runQueryStrict(ctx, "bad")).rejects.toThrow("boom");
  });

  it("throws when the query produced no result at all", async () => {
    h.result = { dataset: {}, provenance: {} };
    await expect(runQueryStrict(ctx, "q")).rejects.toThrow('Query "q" produced no result');
  });
});
