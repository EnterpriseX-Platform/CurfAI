/**
 * GET /api/v1/reports/:id/data is the stable public contract. It returned only
 * { dataset, paramsApplied }, so a query that failed came back as an empty array
 * with HTTP 200 — indistinguishable, to a script, from a query with no rows.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ provenance: {} as Record<string, any> }));

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "u1", tenantId: "t1", role: "viewer" })) }));
vi.mock("@/lib/reporting/runForApi", () => ({
  runReportForApi: vi.fn(async () => ({
    ok: true, reportId: "r1", paramsApplied: { a: 1 },
    dataset: { good: [{ n: 1 }], bad: [] },
    provenance: h.provenance,
  })),
}));

import { GET } from "./route";

const get = () => GET(new NextRequest("http://localhost:3100/api/v1/reports/r1/data"), { params: { id: "r1" } });

beforeEach(() => { h.provenance = { good: {}, bad: {} }; });

describe("GET /api/v1/reports/:id/data", () => {
  it("keeps the existing fields exactly as they were", async () => {
    const body = await (await get()).json();
    expect(body.dataset).toEqual({ good: [{ n: 1 }], bad: [] });
    expect(body.paramsApplied).toEqual({ a: 1 });
  });

  it("reports queryErrors as {} when every query ran", async () => {
    expect((await (await get()).json()).queryErrors).toEqual({});
  });

  it("names the queries that failed, so an empty array can be told from a failure", async () => {
    h.provenance = { good: {}, bad: { executionError: "no such table: t" } };
    const body = await (await get()).json();
    expect(body.queryErrors).toEqual({ bad: "no such table: t" });
    expect(body.dataset.bad).toEqual([]); // still an empty array, as before
  });
});
