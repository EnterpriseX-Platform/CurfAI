/**
 * POST /api/lake/tables/:name/formula — the formula editor's preview and
 * "Describe it" (audit 2026-09-30, C10): a table the caller can't read is
 * not found, a formula problem comes back with its key and spot, a masked
 * input stays masked, and anything else the engine says stays in the log.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const h = vi.hoisted(() => ({ user: null as any, row: null as any, preview: null as any, previewError: null as any }));

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => h.user),
  blockScopedApiKey: (u: any) => (u.scopedReportIds ? NextResponse.json({ error: "scoped" }, { status: 403 }) : null),
  tenantWhere: (u: any) => ({ tenantId: u.tenantId }),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    lakeTable: { findFirst: vi.fn(async ({ where }: any) => (h.row && where.tenantId === h.row.tenantId && where.name === h.row.name ? h.row : null)) },
    membership: { findUnique: vi.fn(async () => ({ rolesJson: "[]" })) },
  },
}));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/lake/tables", () => ({ getTable: vi.fn(async () => ({ columns: [] })) }));
vi.mock("@/lib/lake/formula/preview", () => ({
  previewFormula: vi.fn(async () => { if (h.previewError) throw h.previewError; return h.preview; }),
}));
vi.mock("@/lib/lake/formula/suggest", () => ({ suggestFormula: vi.fn() }));
vi.mock("@/lib/llm", () => ({ requireAiCreditsFor: vi.fn(async () => null) }));

import { FormulaError } from "@/lib/lake/formula/parse";
import { POST } from "./route";

const post = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/lake/tables/people/formula", { method: "POST", body: JSON.stringify(body) }), { params: { name: "people" } });

beforeEach(() => {
  vi.clearAllMocks();
  h.user = { id: "u1", tenantId: "t1", role: "developer", email: "d@test.dev" };
  h.row = {
    id: "lt1", tenantId: "t1", name: "people", ownerUserId: null, visibleToRolesJson: "[]",
    schemaJson: JSON.stringify([{ name: "email", type: "text", sensitivity: "pii", unredactedForRoles: [] }, { name: "qty", type: "number" }]),
  };
  h.previewError = null;
  h.preview = {
    type: "text", uses: ["email"], valueKey: "formula value",
    rows: [{ email: "a@example.com", "formula value": "a@e" }], sampled: 1, blank: 0,
    columns: [{ name: "email", type: "text" }, { name: "qty", type: "number" }],
  };
});

describe("POST /api/lake/tables/:name/formula — preview", () => {
  it("a formula over a masked column is masked in the preview, input and result", async () => {
    const res = await post({ action: "preview", formula: "LEFT(email, 3)" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows[0]).toEqual({ email: "•••••", "formula value": "•••••" });
    expect(JSON.stringify(body)).not.toContain("a@example.com");
  });

  it("a formula problem comes back with its key and where it is", async () => {
    h.previewError = new FormulaError("unknown_column", 4, { name: "cost" });
    const res = await post({ action: "preview", formula: "qty*cost" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ key: "unknown_column", at: 4, params: { name: "cost" } });
  });

  it("anything else the engine says stays in the server log (audit 2026-09-30, S9)", async () => {
    h.previewError = new Error("Conversion Error: Could not convert string 'a@example.com' to INT32");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post({ action: "preview", formula: "ROUND(1, qty)" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "Couldn't preview the formula.", code: "preview_failed" });
    warn.mockRestore();
  });

  it("a table the caller can't read is not found; a viewer can't use the editor", async () => {
    h.row.visibleToRolesJson = JSON.stringify(["finance"]);
    expect((await post({ action: "preview", formula: "qty" })).status).toBe(404);
    h.row.visibleToRolesJson = "[]";
    h.user.role = "viewer";
    expect((await post({ action: "preview", formula: "qty" })).status).toBe(403);
  });
});
