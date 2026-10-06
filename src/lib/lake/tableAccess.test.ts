/**
 * lakeTableFor() — the one door into a lake table for the table routes.
 * The 2026-09-30 audit found a developer changing (and reading back values
 * of) a table that answered them 404, and a report-scoped key reaching every
 * table: both are refused here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

const h = vi.hoisted(() => ({ row: null as any, rolesJson: "[]" }));

vi.mock("@/lib/db", () => ({
  prisma: {
    lakeTable: { findFirst: vi.fn(async ({ where }: any) => (h.row && where.tenantId === h.row.tenantId && where.name === h.row.name ? h.row : null)) },
    membership: { findUnique: vi.fn(async () => ({ rolesJson: h.rolesJson })) },
  },
}));
vi.mock("@/lib/auth", () => ({
  blockScopedApiKey: (u: any) => (u.scopedReportIds ? NextResponse.json({ error: "scoped" }, { status: 403 }) : null),
  tenantWhere: (u: any) => ({ tenantId: u.tenantId }),
}));

import { lakeTableFor } from "./tableAccess";

const user = (over: Record<string, unknown> = {}) => ({ id: "u1", tenantId: "t1", role: "developer", email: "d@test.dev", ...over }) as any;
const status = (r: unknown) => (r instanceof NextResponse ? r.status : 200);

beforeEach(() => {
  h.row = { id: "lt1", tenantId: "t1", name: "people", ownerUserId: null, visibleToRolesJson: "[]", schemaJson: "[]" };
  h.rolesJson = "[]";
});

describe("lakeTableFor", () => {
  it("gives a builder a tenant-wide table, with the viewer to mask by", async () => {
    const r = await lakeTableFor(user(), "people", "build");
    expect(status(r)).toBe(200);
    expect((r as any).row.id).toBe("lt1");
    expect((r as any).viewer).toEqual({ id: "u1", role: "developer", roleSlugs: [] });
  });

  it("refuses a report-scoped API key before looking anything up", async () => {
    expect(status(await lakeTableFor(user({ scopedReportIds: ["r1"], viaApiKey: true }), "people", "read"))).toBe(403);
  });

  it("answers 404 for a table in another workspace or one that isn't there", async () => {
    expect(status(await lakeTableFor(user({ tenantId: "t2" }), "people", "read"))).toBe(404);
    expect(status(await lakeTableFor(user(), "nope", "read"))).toBe(404);
  });

  it("answers 404 — not 403 — for a table the caller can't read, even to change it", async () => {
    h.row.visibleToRolesJson = JSON.stringify(["finance"]);
    expect(status(await lakeTableFor(user(), "people", "read"))).toBe(404);
    expect(status(await lakeTableFor(user(), "people", "build"))).toBe(404);
    // Admins are held to a role-restricted table's roles too (lib/lake/acl.ts).
    expect(status(await lakeTableFor(user({ role: "admin" }), "people", "build"))).toBe(404);
    h.rolesJson = JSON.stringify(["finance"]);
    expect(status(await lakeTableFor(user(), "people", "build"))).toBe(200);
  });

  it("an owner-only table is its owner's alone", async () => {
    h.row.ownerUserId = "u9";
    expect(status(await lakeTableFor(user({ role: "admin" }), "people", "build"))).toBe(404);
    expect(status(await lakeTableFor(user({ id: "u9" }), "people", "build"))).toBe(200);
  });

  it("reading is for every member; changing needs a builder role", async () => {
    expect(status(await lakeTableFor(user({ role: "viewer" }), "people", "read"))).toBe(200);
    expect(status(await lakeTableFor(user({ role: "viewer" }), "people", "build"))).toBe(403);
  });
});
