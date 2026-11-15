/**
 * /api/lake/append authenticates with a push key. A closed workspace's valid key reads as a revoked one — the same
 * 401 — and nothing is quota-checked or written.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ row: null as any, closed: new Set<string>() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    lakeIngestToken: { findUnique: vi.fn(async () => h.row), update: vi.fn(async () => ({})) },
    lakeTable: { findFirst: vi.fn(async () => ({ id: "x" })), upsert: vi.fn(async () => ({})) },
  },
}));
vi.mock("@/lib/lake/tables", () => ({ appendRows: vi.fn(async () => ({ added: 1, newColumns: [] })) }));
vi.mock("@/lib/lake/quota", () => ({ checkWriteAllowed: vi.fn(async () => null) }));
vi.mock("@/lib/lake/storage", () => ({ lakeFileSize: () => 1 }));
vi.mock("@/lib/lake/bust", () => ({ bustLakeCacheForTenant: vi.fn(async () => {}) }));
vi.mock("@/lib/tenantGuard", () => ({ tenantIsOpen: async (id: string) => !h.closed.has(id), closedTenantIds: async () => [], forgetTenantStatus: () => {} }));

import { appendRows } from "@/lib/lake/tables";
import { checkWriteAllowed } from "@/lib/lake/quota";
import { POST } from "./route";

const SECRET = "supersecretvalue";
const post = () =>
  POST(new NextRequest("http://x/api/lake/append", {
    method: "POST", headers: { authorization: `Bearer lk_abcd1234.${SECRET}`, "content-type": "application/json" }, body: JSON.stringify([{ a: 1 }]),
  }));

beforeEach(() => {
  vi.clearAllMocks();
  h.closed.clear();
  h.row = { id: "tok1", tenantId: "t1", tableName: "people", prefix: "lk_abcd1234", hashedSecret: crypto.createHash("sha256").update(SECRET).digest("hex"), revokedAt: null, label: "l", createdById: null };
});

describe("POST /api/lake/append", () => {
  it("appends for an open workspace", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(appendRows).toHaveBeenCalledTimes(1);
  });

  it("refuses a closed workspace's valid key with the invalid-token 401 and writes nothing", async () => {
    h.closed.add("t1");
    const res = await post();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid token" });
    expect(checkWriteAllowed).not.toHaveBeenCalled();
    expect(appendRows).not.toHaveBeenCalled();
  });
});
