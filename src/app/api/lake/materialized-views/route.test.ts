/**
 * Found live during a Tables 2.0 edge-case pass (2026-09-20): creating a
 * materialized view whose name is already taken — a completely ordinary
 * user action, not an attack or a rare corner case — crashed this route
 * with an uncaught PrismaClientKnownRequestError (P2002 on the
 * @@unique([tenantId, name]) constraint) and an empty 500, instead of the
 * clean 409 every sibling lake route (parquet-exports, cdc-subscriptions,
 * table-shares) already returns for the exact same constraint shape.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ requireAdminOrEditor: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/lake/materialize", () => ({ refreshMaterializedView: vi.fn() }));

const createMock = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    dataSource: { findFirst: vi.fn(async () => ({ id: "ds1", name: "Curf Tables" })) },
    materializedView: { create: (...args: any[]) => createMock(...args) },
  },
}));

import { requireAdminOrEditor } from "@/lib/auth";
import { POST } from "./route";

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost:3100/api/lake/materialized-views", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }),
  );
}

const VALID_BODY = { name: "my_view", sql: "SELECT 1 AS x FROM t", dataSourceId: "ds1" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdminOrEditor).mockResolvedValue({ id: "u1", tenantId: "t1", role: "admin", email: "a@test.dev" } as any);
});

describe("POST /api/lake/materialized-views — duplicate name", () => {
  it("returns a clean 409 instead of crashing when the (tenantId, name) unique constraint is violated", async () => {
    const err: any = new Error("Unique constraint failed");
    err.code = "P2002";
    createMock.mockRejectedValueOnce(err);

    const res = await post(VALID_BODY);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/already exists/i);
    expect(body.error).toContain("my_view");
  });

  it("still creates normally when the name is free", async () => {
    createMock.mockResolvedValueOnce({ id: "mv1", name: "my_view", dataSourceId: "ds1", cron: null });

    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mv.id).toBe("mv1");
  });

  it("returns a generic 500 (not a crash) for a create failure that isn't the unique constraint", async () => {
    createMock.mockRejectedValueOnce(new Error("connection reset"));

    const res = await post(VALID_BODY);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/connection reset/);
  });
});
