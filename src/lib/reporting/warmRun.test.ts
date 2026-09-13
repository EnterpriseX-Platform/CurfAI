/**
 * warmRunReport — the run recorded when a report is created.
 *
 * The load-bearing contract is that it NEVER throws. It is called inside the
 * Master Builder applier's per-report try block, so a throw here would be
 * caught as "report creation failed" and the report would be reported as
 * broken when it exists and is fine — the run just didn't work against its
 * default parameters.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findFirst = vi.fn();
const create = vi.fn();
const runWithProof = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    report: { findFirst: (...a: any[]) => findFirst(...a) },
    reportRun: { create: (...a: any[]) => create(...a) },
  },
}));
vi.mock("./runner", () => ({ runReportWithProof: (...a: any[]) => runWithProof(...a) }));

const { warmRunReport } = await import("./warmRun");

// Parsed by the real ReportSchema, not a mock — a definition that has drifted
// out of shape must surface as a failed warm run, not a thrown exception.
const definition = JSON.stringify({
  version: 1,
  name: "R",
  parameters: [{ name: "region", label: "Region", type: "string", required: false, default: "All" }],
  dataSources: [],
  pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks: [] }],
});

beforeEach(() => {
  findFirst.mockReset(); create.mockReset(); runWithProof.mockReset();
  create.mockResolvedValue({});
});

describe("a successful warm run", () => {
  it("records a completed run with the snapshot", async () => {
    findFirst.mockResolvedValue({ id: "r1", definition });
    runWithProof.mockResolvedValue({ dataset: { q1: [{ a: 1 }, { a: 2 }] }, provenance: { q1: {} } });

    const res = await warmRunReport({ tenantId: "t1", reportId: "r1", userId: "u1" });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.rows).toBe(2);
    const row = create.mock.calls[0][0].data;
    expect(row.status).toBe("completed");
    expect(row.tenantId).toBe("t1");
    expect(JSON.parse(row.dataset)).toEqual({ q1: [{ a: 1 }, { a: 2 }] });
  });

  it("runs with the report's parameter defaults", async () => {
    findFirst.mockResolvedValue({ id: "r1", definition });
    runWithProof.mockResolvedValue({ dataset: {}, provenance: {} });
    await warmRunReport({ tenantId: "t1", reportId: "r1" });
    expect(runWithProof.mock.calls[0][0].params).toEqual({ region: "All" });
  });

  it("is tenant-scoped when it resolves the report", async () => {
    findFirst.mockResolvedValue({ id: "r1", definition });
    runWithProof.mockResolvedValue({ dataset: {}, provenance: {} });
    await warmRunReport({ tenantId: "t1", reportId: "r1" });
    expect(findFirst.mock.calls[0][0].where).toMatchObject({ id: "r1", tenantId: "t1" });
  });
});

describe("failure is reported, never thrown", () => {
  it("returns a failure when the query blows up", async () => {
    findFirst.mockResolvedValue({ id: "r1", definition });
    runWithProof.mockRejectedValue(new Error("no such table: retail_sales"));

    const res = await warmRunReport({ tenantId: "t1", reportId: "r1" });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no such table/);
  });

  it("still records the attempt, so a broken report is visible in History", async () => {
    // A card that stays blank because the query is broken should be
    // distinguishable from one nobody has opened.
    findFirst.mockResolvedValue({ id: "r1", definition });
    runWithProof.mockRejectedValue(new Error("boom"));
    await warmRunReport({ tenantId: "t1", reportId: "r1" });
    expect(create.mock.calls[0][0].data.status).toBe("failed");
  });

  it("writes the actual error onto the failed run, not just the status", async () => {
    // ReportRun.error exists precisely so a failed row is diagnosable
    // without re-running the report — a bare status:"failed" tells a reader
    // nothing about WHY. The pdf export route already sets this field on
    // failure; warmRunReport must follow the same convention.
    findFirst.mockResolvedValue({ id: "r1", definition });
    runWithProof.mockRejectedValue(new Error("no such table: retail_sales"));
    await warmRunReport({ tenantId: "t1", reportId: "r1" });
    expect(create.mock.calls[0][0].data.error).toMatch(/no such table: retail_sales/);
  });

  it("does not throw even when recording the failure also fails", async () => {
    // Worst case: the query failed AND the DB write failed. Still resolves.
    findFirst.mockResolvedValue({ id: "r1", definition });
    runWithProof.mockRejectedValue(new Error("boom"));
    create.mockRejectedValue(new Error("db down"));
    await expect(warmRunReport({ tenantId: "t1", reportId: "r1" })).resolves.toMatchObject({ ok: false });
  });

  it("returns a failure for a report that isn't there", async () => {
    findFirst.mockResolvedValue(null);
    const res = await warmRunReport({ tenantId: "t1", reportId: "nope" });
    expect(res.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("returns a failure rather than throwing on an unparseable definition", async () => {
    findFirst.mockResolvedValue({ id: "r1", definition: "{not json" });
    const res = await warmRunReport({ tenantId: "t1", reportId: "r1" });
    expect(res.ok).toBe(false);
  });
});

describe("snapshot size", () => {
  it("drops the dataset and its provenance together when it is too large", async () => {
    // Mirrors the viewer's own rule, so a warm run and a viewed run produce
    // interchangeable history rows rather than two shapes to tell apart.
    findFirst.mockResolvedValue({ id: "r1", definition });
    runWithProof.mockResolvedValue({
      dataset: { q1: [{ blob: "x".repeat(2_100_000) }] },
      provenance: { q1: { hash: "abc" } },
    });
    await warmRunReport({ tenantId: "t1", reportId: "r1" });
    const row = create.mock.calls[0][0].data;
    expect(row.dataset).toBeNull();
    expect(row.provenance).toBeNull();
  });
});
