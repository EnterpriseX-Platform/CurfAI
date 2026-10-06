/**
 * GET /api/lake/tables — the table list. Each column's `sample` is a value
 * from the table, so it's masked as the viewer's rows would be: the
 * 2026-09-30 audit (S1) found a viewer reading a pii-tagged email here in
 * full, while the table page and the rows API masked it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const h = vi.hoisted(() => ({ user: null as any, tables: [] as any[] }));

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => h.user),
  requireAdminOrEditor: vi.fn(),
  blockScopedApiKey: (u: any) => (u.scopedReportIds ? NextResponse.json({ error: "scoped" }, { status: 403 }) : null),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    lakeTable: { findMany: vi.fn(async () => h.tables) },
    membership: { findUnique: vi.fn(async () => ({ rolesJson: "[]" })) },
  },
}));
vi.mock("@/lib/lake/quota", () => ({
  checkWriteAllowed: vi.fn(),
  getQuotaForTenant: vi.fn(async () => ({})),
  getUsageForTenant: vi.fn(async () => ({})),
}));
vi.mock("@/lib/lake/tables", () => ({ createOrReplaceTable: vi.fn() }));
vi.mock("@/lib/lake/parseFile", () => ({ parseUpload: vi.fn() }));
vi.mock("@/lib/lake/tableRegistration", () => ({ newTableNameProblem: vi.fn(), registerCreatedTable: vi.fn() }));

import { GET } from "./route";

const table = {
  id: "lt1", tenantId: "t1", name: "people", sourceKind: "manual", sourceConfigJson: null,
  ownerUserId: null, visibleToRolesJson: "[]", rowCount: 2, sizeBytes: 10,
  createdAt: new Date(0), updatedAt: new Date(0),
  schemaJson: JSON.stringify([
    { name: "store", type: "text", sample: "North" },
    { name: "email", type: "text", sample: "person1@example.com", sensitivity: "pii", unredactedForRoles: [] },
    { name: "email_domain", type: "text", sample: "example.com", formula: "RIGHT(email, 11)" },
  ]),
};

async function list() {
  const res = await GET(new NextRequest("http://localhost:3100/api/lake/tables"));
  return { status: res.status, body: await res.json() };
}
const sampleOf = (body: any, col: string) => body.items[0].schema.find((c: any) => c.name === col)?.sample;

beforeEach(() => {
  h.tables = [table];
  h.user = { id: "u1", tenantId: "t1", role: "viewer", email: "v@test.dev" };
});

describe("GET /api/lake/tables — column samples", () => {
  it("masks a tagged column's sample for a viewer, and a formula column that reads it", async () => {
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(sampleOf(body, "email")).toBe("•••••");
    expect(sampleOf(body, "email_domain")).toBe("•••••");
    expect(sampleOf(body, "store")).toBe("North");
    expect(JSON.stringify(body)).not.toContain("person1@example.com");
  });

  it("shows an admin the value, as the table page does", async () => {
    h.user.role = "admin";
    expect(sampleOf((await list()).body, "email")).toBe("person1@example.com");
  });

  it("refuses a report-scoped API key", async () => {
    h.user = { ...h.user, viaApiKey: true, scopedReportIds: ["r1"] };
    expect((await list()).status).toBe(403);
  });
});
