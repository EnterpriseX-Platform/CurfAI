/**
 * introspectTables() builds the table inventory the report generator and
 * recommend-KPIs put in the model's prompt. For a lake source it listed every
 * lake table in the workspace with a raw sample row, regardless of the
 * table's ACL (owner-only, role-restricted) or its columns' sensitivity tags.
 * It now takes the viewer the prompt is built for: only the tables they may
 * read are listed, and each sample row is masked the way they'd see it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: { lakeTable: { findMany: vi.fn() } } }));
vi.mock("@/lib/auth", () => ({ requireAdminOrEditor: vi.fn(), tenantWhere: vi.fn(), blockScopedApiKey: vi.fn(), getUserRoles: vi.fn(async () => []) }));
vi.mock("@/lib/reporting/runner", () => ({ ANONYMOUS_VIEWER: { id: "anonymous", isAdmin: false, roles: [] } }));
vi.mock("@/lib/rls", () => ({ withTenantContext: vi.fn() }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/rateLimit", () => ({ ensureLimit: vi.fn() }));
vi.mock("@/lib/billing", () => ({ requireReportQuota: vi.fn() }));
vi.mock("@/lib/llm", () => ({ callLLM: vi.fn(), requireAiCreditsFor: vi.fn() }));
vi.mock("@/ee", () => ({ ee: {} }));
vi.mock("better-sqlite3", () => ({ default: vi.fn() }));
vi.mock("@/lib/lake/tenantEngine", () => ({ tenantLakeEngine: vi.fn(async () => "sqlite") }));
vi.mock("@/lib/lake/tables", () => ({ previewRows: vi.fn() }));
// These tests are about what the model is shown; the gate has its own (reportGate.test.ts).
vi.mock("@/lib/intelligence/reportGate", () => ({ gateGeneratedReport: vi.fn(), persistableDefinition: vi.fn() }));

import { prisma } from "@/lib/db";
import { previewRows } from "@/lib/lake/tables";
import { introspectTables } from "./route";

const LAKE_DS = { id: "lake1", name: "Curf Tables", kind: "lake", connection: "lake://t1" };
const LAKE_TABLES = [
  {
    name: "customers", tenantId: "t1", ownerUserId: null, visibleToRolesJson: "[]",
    schemaJson: JSON.stringify([{ name: "email", type: "text", sample: "ann@example.com", sensitivity: "pii" }, { name: "region", type: "text" }]),
  },
  { name: "payroll", tenantId: "t1", ownerUserId: null, visibleToRolesJson: JSON.stringify(["hr"]), schemaJson: JSON.stringify([{ name: "salary", type: "number" }]) },
  { name: "my_notes", tenantId: "t1", ownerUserId: "u-owner", visibleToRolesJson: "[]", schemaJson: JSON.stringify([{ name: "note", type: "text" }]) },
];

const MEMBER = { id: "u-dev", isAdmin: false, roles: ["finance"] };
const ADMIN = { id: "u-admin", isAdmin: true, roles: [] as string[] };
const HR = { id: "u-hr", isAdmin: false, roles: ["hr"] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.lakeTable.findMany).mockResolvedValue(LAKE_TABLES as any);
  vi.mocked(previewRows).mockImplementation(async (_t: string, name: string) =>
    name === "customers" ? [{ email: "ann@example.com", region: "North" }]
      : name === "payroll" ? [{ salary: 120000 }]
      : [{ note: "private" }]);
});

describe("introspectTables — a lake source, as the viewer the prompt is for", () => {
  it("lists only the tables a member may read, with the sample row's tagged column masked", async () => {
    const out = await introspectTables(LAKE_DS, MEMBER);

    expect(out.kind).toBe("lake");
    expect(out.tables).toEqual([
      { name: "customers", columns: [{ name: "email", type: "text" }, { name: "region", type: "text" }], sample: { email: "•••••", region: "North" } },
    ]);
    // The unreadable tables are never read at all.
    expect(vi.mocked(previewRows).mock.calls).toEqual([["t1", "customers", 1]]);
    expect(vi.mocked(prisma.lakeTable.findMany).mock.calls[0][0]).toMatchObject({ where: { tenantId: "t1" } });
  });

  it("shows an admin unmasked values, but not a table outside its roles or someone's own", async () => {
    const out = await introspectTables(LAKE_DS, ADMIN);

    expect(out.tables.map((t) => t.name)).toEqual(["customers"]);
    expect(out.tables[0].sample).toEqual({ email: "ann@example.com", region: "North" });
  });

  it("lists a role-restricted table for a holder of the role", async () => {
    const out = await introspectTables(LAKE_DS, HR);

    expect(out.tables.map((t) => t.name)).toEqual(["customers", "payroll"]);
    expect(out.tables[1].sample).toEqual({ salary: 120000 });
    expect(out.tables[0].sample).toEqual({ email: "•••••", region: "North" });
  });

  it("lists the owner's own owner-only table to them", async () => {
    const out = await introspectTables(LAKE_DS, { id: "u-owner", isAdmin: false, roles: [] });

    expect(out.tables.map((t) => t.name)).toEqual(["customers", "my_notes"]);
  });
});
