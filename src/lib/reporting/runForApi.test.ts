/**
 * runReportForApi stores a snapshot of every run it does (viewer refresh, the public
 * API). A query that failed was stored as an empty array on a "completed" run, which
 * then became the day's latest KPI-history point and the next run's "previous" value.
 * It must record the run as not-completed, with the reason.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ provenance: {} as Record<string, any> }));

vi.mock("@/lib/db", () => ({
  prisma: {
    report: { findFirst: vi.fn() },
    reportRun: { create: vi.fn(async () => ({})) },
  },
}));
vi.mock("@/lib/reporting/runner", () => ({
  runReportWithProof: vi.fn(async () => ({ dataset: { q: [] }, provenance: h.provenance })),
}));
vi.mock("@/lib/auth", async (importOriginal) => ({
  filterBlocksForRoles: (await importOriginal<typeof import("@/lib/auth")>()).filterBlocksForRoles,
  getUserRoles: vi.fn(async () => []),
  reportWhere: vi.fn(() => ({ tenantId: "t1" })),
}));
vi.mock("@/lib/rateLimit", () => ({ ensureLimit: vi.fn(() => null) }));

import { prisma } from "@/lib/db";
import { runReportWithProof } from "@/lib/reporting/runner";
import { runReportForApi } from "./runForApi";

const REPORT = {
  version: 1, name: "R", parameters: [],
  dataSources: [{ id: "q", name: "Q", dataSourceId: "ds1", sql: "SELECT 1" }],
  pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks: [] }],
};
const user = { id: "u1", tenantId: "t1", role: "admin", viaApiKey: false } as any;
const url = new URL("http://localhost:3100/api/v1/reports/r1/data");
const recorded = () => vi.mocked(prisma.reportRun.create).mock.calls[0][0].data as any;

beforeEach(() => {
  vi.clearAllMocks();
  h.provenance = { q: {} };
  vi.mocked(prisma.report.findFirst).mockResolvedValue({ id: "r1", tenantId: "t1", definition: JSON.stringify(REPORT) } as any);
});

describe("runReportForApi — how the run is recorded", () => {
  it("a healthy run is 'completed' with no error", async () => {
    const res = await runReportForApi(user, "r1", url);
    expect(res.ok).toBe(true);
    expect(recorded()).toMatchObject({ status: "completed", error: null });
  });

  it("a run in which a query failed is recorded as failed, with the reason — not as a completed empty snapshot", async () => {
    h.provenance = { q: { executionError: "Binder Error: no such column" } };
    const res = await runReportForApi(user, "r1", url);
    expect(res.ok).toBe(true); // the caller still gets its (partial) result...
    expect(recorded().status).toBe("failed"); // ...but nothing will use it as a baseline
    expect(recorded().error).toContain("1 of 1 queries didn't run: Binder Error");
    expect(recorded().dataset).not.toBeNull(); // the snapshot itself is kept for the History page
  });

  it("a run in which a source was hidden from this viewer is 'restricted', not 'completed'", async () => {
    h.provenance = { q: { accessDeniedNote: "Hidden by visibility" } };
    await runReportForApi(user, "r1", url);
    expect(recorded().status).toBe("restricted");
  });

  it("hands the provenance back so the caller can report which queries failed", async () => {
    h.provenance = { q: { executionError: "boom" } };
    const res = await runReportForApi(user, "r1", url);
    expect(res.ok && res.provenance.q.executionError).toBe("boom");
    expect(runReportWithProof).toHaveBeenCalledTimes(1);
  });
});
