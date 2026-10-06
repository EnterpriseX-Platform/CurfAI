/**
 * Binding real rows over a synthetic table re-infers every column. The
 * redaction tags and Master Builder's `syntheticHint` join hints on the
 * existing catalog row can't be re-derived from data, so they must survive
 * the swap — otherwise a `pii` column silently starts showing raw values to
 * non-admin viewers the moment real data lands in it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ row: null as any, updated: null as any }));

vi.mock("@/lib/auth", () => ({
  requireAdminOrEditor: vi.fn(),
  // lakeTableFor() (lib/lake/tableAccess.ts): scoped keys refused, the workspace filter.
  blockScopedApiKey: vi.fn((u: any) => (u?.scopedReportIds ? new Response(null, { status: 403 }) : null)),
  tenantWhere: (u: any) => ({ tenantId: u.tenantId }),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    lakeTable: {
      findFirst: vi.fn(async () => h.row),
      update: vi.fn(async ({ data }: any) => { h.updated = data; return { ...h.row, ...data }; }),
    },
  },
}));
vi.mock("@/lib/lake/tables", () => ({
  createOrReplaceTable: vi.fn(async ({ rows }: any) => ({
    rowCount: rows.length,
    columns: Object.keys(rows[0] ?? {}).map((name) => ({ name, type: "text" })),
  })),
}));
vi.mock("@/lib/lake/quota", () => ({ checkWriteAllowed: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/lake/bust", () => ({ bustLakeCacheForTenant: vi.fn(async () => {}) }));
vi.mock("@/ee", () => ({ ee: {} }));

import { requireAdminOrEditor } from "@/lib/auth";
import { bustLakeCacheForTenant } from "@/lib/lake/bust";
import { POST } from "./route";

const TAGGED = [
  { name: "name", type: "text" },
  { name: "email", type: "text", sensitivity: "pii", unredactedForRoles: ["finance"] },
  { name: "city", type: "text", syntheticHint: "fk:cities" },
];

function bind(rows: unknown[]) {
  return POST(
    new NextRequest("http://localhost:3100/api/lake/tables/people/bind", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows }),
    }),
    { params: { name: "people" } },
  );
}

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(async () => {
  await flush(); // drain a bust the previous test scheduled but didn't wait for
  vi.clearAllMocks();
  h.updated = null;
  h.row = {
    id: "lt1", tenantId: "t1", name: "people", sourceKind: "upload",
    sourceConfigJson: JSON.stringify({ synthetic: true, buildId: "b1" }),
    schemaJson: JSON.stringify(TAGGED),
  };
  vi.mocked(requireAdminOrEditor).mockReset().mockResolvedValue({ id: "u1", tenantId: "t1", role: "admin", email: "a@test.dev" } as any);
});

describe("POST /api/lake/tables/:name/bind — governance metadata", () => {
  it("keeps the redaction tags and join hints, and passes a newly added column through untagged", async () => {
    const res = await bind([{ name: "Ann", email: "ann@real.example", city: "Paris", phone: "555-0100" }]);
    expect(res.status).toBe(200);

    const schema = JSON.parse(h.updated.schemaJson) as any[];
    expect(schema.map((c) => c.name)).toEqual(["name", "email", "city", "phone"]);
    expect(schema.find((c) => c.name === "email")).toMatchObject({ sensitivity: "pii", unredactedForRoles: ["finance"] });
    expect(schema.find((c) => c.name === "city")).toMatchObject({ syntheticHint: "fk:cities" });
    expect(schema.find((c) => c.name === "phone").sensitivity).toBeUndefined();
  });
});

describe("POST /api/lake/tables/:name/bind — cache invalidation", () => {
  it("busts cached query results once real rows replace the synthetic ones", async () => {
    const res = await bind([{ name: "Ann", email: "ann@real.example", city: "Paris" }]);
    expect(res.status).toBe(200);
    await flush();
    expect(bustLakeCacheForTenant).toHaveBeenCalledTimes(1);
    expect(bustLakeCacheForTenant).toHaveBeenCalledWith("t1", "people");
  });

  it("does not bust when the bind is refused (missing columns) — nothing was replaced", async () => {
    const res = await bind([{ name: "Ann" }]); // email + city missing
    expect(res.status).toBe(422);
    await flush();
    expect(bustLakeCacheForTenant).not.toHaveBeenCalled();
  });
});
