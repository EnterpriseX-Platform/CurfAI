/**
 * The schema editor changes a table's shape (or, for retype, its contents), so
 * cached query results that read it are stale the moment it succeeds. Every
 * other lake write route busts the cache; this one didn't, so a report kept
 * serving pre-edit results until the 30-second TTL ran out.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ row: null as any }));

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
  addColumn: vi.fn(async () => {}),
  renameColumn: vi.fn(async () => {}),
  dropColumn: vi.fn(async () => {}),
  retypeColumn: vi.fn(async () => ({ updated: 1, unchanged: 0 })),
  setFormulaColumn: vi.fn(async () => ({ type: "text", uses: ["a"] })),
  getTable: vi.fn(async () => ({ columns: [{ name: "a", type: "text" }] })),
  previewRows: vi.fn(async () => [{ a: "1" }]),
}));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/lake/bust", () => ({ bustLakeCacheForTenant: vi.fn(async () => {}) }));
vi.mock("@/ee", () => ({ ee: {} }));

import { requireUser } from "@/lib/auth";
import { addColumn, renameColumn, dropColumn, retypeColumn, setFormulaColumn, getTable } from "@/lib/lake/tables";
import { prisma } from "@/lib/db";
import { FormulaError } from "@/lib/lake/formula/parse";
import { bustLakeCacheForTenant } from "@/lib/lake/bust";
import { POST } from "./route";

const flush = () => new Promise((r) => setImmediate(r));

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost:3100/api/lake/tables/people/schema", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }),
    { params: { name: "people" } },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.row = { id: "lt1", tenantId: "t1", name: "people", ownerUserId: null, schemaJson: JSON.stringify([{ name: "a", type: "text" }]) };
  vi.mocked(requireUser).mockResolvedValue({ id: "u1", tenantId: "t1", role: "admin", email: "a@test.dev" } as any);
});

describe("POST /api/lake/tables/:name/schema — cache invalidation", () => {
  it.each([
    ["addColumn", { action: "addColumn", name: "b" }],
    ["renameColumn", { action: "renameColumn", oldName: "a", newName: "b" }],
    ["dropColumn", { action: "dropColumn", name: "a" }],
    ["retype", { action: "retype", name: "a", type: "number" }],
  ])("busts the tenant's cached query results after a successful %s", async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(200);
    await flush();
    expect(bustLakeCacheForTenant).toHaveBeenCalledTimes(1);
    expect(bustLakeCacheForTenant).toHaveBeenCalledWith("t1", "people");
  });

  it("does not bust when the change failed — nothing changed, so nothing is stale", async () => {
    vi.mocked(renameColumn).mockRejectedValueOnce(new Error('Column "a" not found'));
    const res = await post({ action: "renameColumn", oldName: "a", newName: "b" });
    expect(res.status).toBe(400);
    await flush();
    expect(bustLakeCacheForTenant).not.toHaveBeenCalled();
  });

  it("does not bust for a table that doesn't exist, or a request that isn't allowed", async () => {
    h.row = null;
    expect((await post({ action: "addColumn", name: "b" })).status).toBe(404);
    vi.mocked(requireUser).mockResolvedValue({ id: "u2", tenantId: "t1", role: "executive", email: "v@test.dev" } as any);
    h.row = { id: "lt1", tenantId: "t1", name: "people", ownerUserId: null, schemaJson: "[]" };
    expect((await post({ action: "addColumn", name: "b" })).status).toBe(403);
    await flush();
    expect(bustLakeCacheForTenant).not.toHaveBeenCalled();
    expect(addColumn).not.toHaveBeenCalled();
    expect(dropColumn).not.toHaveBeenCalled();
    expect(retypeColumn).not.toHaveBeenCalled();
  });
});

describe("POST /api/lake/tables/:name/schema — formula columns", () => {
  it("adds one and saves it with the tags of the column it reads", async () => {
    h.row.schemaJson = JSON.stringify([{ name: "a", type: "text", sensitivity: "pii", unredactedForRoles: ["analyst"] }]);
    vi.mocked(getTable).mockResolvedValueOnce({ columns: [{ name: "a", type: "text" }, { name: "a3", type: "text", formula: "LEFT(a, 3)" }] } as any);
    const res = await post({ action: "addFormula", name: "a3", formula: "LEFT(a, 3)" });
    expect(res.status).toBe(200);
    expect(setFormulaColumn).toHaveBeenCalledWith({ tenantId: "t1", tableName: "people", columnName: "a3", formula: "LEFT(a, 3)", replace: false });
    const saved = JSON.parse(vi.mocked(prisma.lakeTable.update).mock.calls[0]![0].data.schemaJson as string);
    expect(saved[1]).toMatchObject({ name: "a3", formula: "LEFT(a, 3)", sensitivity: "pii", unredactedForRoles: ["analyst"] });
    await flush();
  });

  it("a formula that doesn't check out is a 400 that says where", async () => {
    vi.mocked(setFormulaColumn).mockRejectedValueOnce(new FormulaError("unknown_column", 0, { name: "b" }));
    const res = await post({ action: "setFormula", name: "a3", formula: "b" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "There's no column called b", at: 0, code: "unknown_column", key: "unknown_column", params: { name: "b" } });
    await flush();
    expect(bustLakeCacheForTenant).not.toHaveBeenCalled();
  });

  it("a typed blank column is saved as the type asked for", async () => {
    vi.mocked(getTable).mockResolvedValueOnce({ columns: [{ name: "a", type: "text" }, { name: "due", type: "text" }] } as any);
    await post({ action: "addColumn", name: "due", type: "date" });
    expect(addColumn).toHaveBeenCalledWith({ tenantId: "t1", tableName: "people", columnName: "due", type: "date", defaultValue: undefined });
    const saved = JSON.parse(vi.mocked(prisma.lakeTable.update).mock.calls[0]![0].data.schemaJson as string);
    expect(saved[1]).toMatchObject({ name: "due", type: "date" });
    await flush();
  });
});

describe("POST /api/lake/tables/:name/schema — who may change it, and what comes back", () => {
  it("a table the developer can't read is not found — never changed (audit 2026-09-30, S3)", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u2", tenantId: "t1", role: "developer", email: "d@test.dev" } as any);
    h.row = { ...h.row, visibleToRolesJson: JSON.stringify(["finance"]) };
    const res = await post({ action: "addColumn", name: "b" });
    expect(res.status).toBe(404);
    expect(addColumn).not.toHaveBeenCalled();
  });

  it("returns column samples masked as the developer's rows would be", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "u2", tenantId: "t1", role: "developer", email: "d@test.dev" } as any);
    h.row.schemaJson = JSON.stringify([{ name: "a", type: "text", sensitivity: "pii", unredactedForRoles: [] }]);
    const res = await post({ action: "addColumn", name: "b" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schema.find((c: any) => c.name === "a").sample).toBe("•••••");
    // The catalog keeps the real sample: only the response is masked.
    const saved = JSON.parse(vi.mocked(prisma.lakeTable.update).mock.calls[0]![0].data.schemaJson as string);
    expect(saved.find((c: any) => c.name === "a").sample).toBe("1");
    await flush();
  });
});
