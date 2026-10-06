/**
 * Applying a typed conversion rewrites a table's columns for good, so cached
 * query results computed on the old column types are stale the moment it
 * succeeds. A refusal (flag off, drift, an open branch) changes nothing and
 * must not bust.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ row: null as any, flagOn: true }));

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(),
  // lakeTableFor() (lib/lake/tableAccess.ts): scoped keys refused, the workspace filter.
  blockScopedApiKey: vi.fn((u: any) => (u?.scopedReportIds ? new Response(null, { status: 403 }) : null)),
  tenantWhere: (u: any) => ({ tenantId: u.tenantId }),
}));
vi.mock("@/lib/db", () => ({
  prisma: { lakeTable: { findFirst: vi.fn(async () => h.row), update: vi.fn(async () => ({})) } },
}));
vi.mock("@/lib/lake/tables", () => ({
  previewTypedConversion: vi.fn(),
  applyTypedConversion: vi.fn(),
  typedColumnsEnabled: vi.fn(() => h.flagOn),
  previewRows: vi.fn(async () => [{ amount: "100" }]),
}));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/lake/bust", () => ({ bustLakeCacheForTenant: vi.fn(async () => {}) }));
vi.mock("@/ee", () => ({ ee: {} }));

import { requireUser } from "@/lib/auth";
import { applyTypedConversion } from "@/lib/lake/tables";
import { TypedConversionDriftError } from "@/lib/lake/typedConversionErrors";
import { bustLakeCacheForTenant } from "@/lib/lake/bust";
import { POST } from "./route";

const flush = () => new Promise((r) => setImmediate(r));

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost:3100/api/lake/tables/subs/typed-conversion", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }),
    { params: { name: "subs" } },
  );
}
const APPLY = { columns: ["amount"], confirmedLossy: { amount: 0 } };

beforeEach(() => {
  vi.clearAllMocks();
  h.flagOn = true;
  h.row = { id: "lt1", tenantId: "t1", name: "subs", schemaJson: JSON.stringify([{ name: "amount", type: "text" }]) };
  vi.mocked(requireUser).mockResolvedValue({ id: "u1", tenantId: "t1", role: "admin", email: "a@test.dev" } as any);
  vi.mocked(applyTypedConversion).mockResolvedValue({
    convertedColumns: ["amount"], skippedColumns: [], lossyCells: 0, lossyByColumn: { amount: 0 },
    columns: [{ name: "amount", type: "number" }],
  } as any);
});

describe("POST /api/lake/tables/:name/typed-conversion — cache invalidation", () => {
  it("busts the tenant's cached query results after a successful conversion", async () => {
    const res = await post(APPLY);
    expect(res.status).toBe(200);
    await flush();
    expect(bustLakeCacheForTenant).toHaveBeenCalledTimes(1);
    expect(bustLakeCacheForTenant).toHaveBeenCalledWith("t1", "subs");
  });

  it("busts even if the catalog bookkeeping after it fails — the data already changed", async () => {
    const { prisma } = await import("@/lib/db");
    vi.mocked(prisma.lakeTable.update).mockRejectedValueOnce(new Error("db down"));
    await post(APPLY).catch(() => {});
    await flush();
    expect(bustLakeCacheForTenant).toHaveBeenCalledWith("t1", "subs");
  });

  it("does not bust when the conversion is refused or fails", async () => {
    vi.mocked(applyTypedConversion).mockRejectedValueOnce(new TypedConversionDriftError({ amount: 0 }, { amount: 3 }));
    expect((await post(APPLY)).status).toBe(409);

    vi.mocked(applyTypedConversion).mockRejectedValueOnce(new Error("boom"));
    expect((await post(APPLY)).status).toBe(400);

    h.flagOn = false;
    expect((await post(APPLY)).status).toBe(409);

    await flush();
    expect(bustLakeCacheForTenant).not.toHaveBeenCalled();
  });
});
