/**
 * Any reader could mint an embed token for any block id that appeared in the
 * definition (a substring check), including a block the author hid from
 * their role, and the public iframe then showed it. Verified live on
 * 2026-09-24 with a viewer-role API key and a table gated to a role it lacked.
 *
 * The iframe is public, so a block gated to any role can't be embedded, and
 * a block hidden from the caller answers exactly like one that doesn't exist.
 * The real route runs here. Only the caller, their custom role slugs and the
 * tier gate are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ user: null as any, roles: [] as string[] }));

vi.mock("@/lib/db", () => ({ prisma: { report: { findFirst: vi.fn() } } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  const { NextResponse } = await import("next/server");
  return {
    ...actual,
    requireUser: vi.fn(async () => h.user),
    // Same rule as the real requireAdminOrEditor: builders only.
    requireAdminOrEditor: vi.fn(async () =>
      h.user.role === "admin" || h.user.role === "developer" ? h.user : NextResponse.json({ error: "Forbidden" }, { status: 403 })),
    getUserRoles: vi.fn(async () => h.roles),
  };
});
vi.mock("@/lib/featureGate", () => ({ featureGate: vi.fn(async () => null) }));

import { prisma } from "@/lib/db";
import { verifyEmbedToken } from "@/lib/embed/token";
import { verifyRenderToken } from "@/lib/reporting/renderToken";
import { POST } from "./route";

const kpi = (id: string, extra: object = {}) => ({
  id, type: "kpi", x: 0, y: 0, w: 4, h: 3, ...extra,
  config: { queryId: "q", label: id, valueField: "v", format: "number" },
});
const DEFINITION = JSON.stringify({
  version: 1, name: "People", parameters: [],
  dataSources: [{ id: "q", name: "Q", dataSourceId: "ds1", sql: "SELECT 1" }],
  pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks: [kpi("k_open"), kpi("k_fin", { visibleToRoles: ["finance"] })] }],
});

const mint = (blockId: string) => POST(
  new NextRequest("http://localhost:3100/api/reports/r1/embed-token", { method: "POST", body: JSON.stringify({ blockId }) }),
  { params: { id: "r1" } },
);

beforeEach(() => {
  vi.clearAllMocks();
  // A builder whose custom role tags (h.roles) don't include the gated block's role.
  h.user = { id: "key-1", email: null, role: "developer", tenantId: "t1", viaApiKey: true };
  h.roles = [];
  vi.mocked(prisma.report.findFirst).mockResolvedValue({ id: "r1", definition: DEFINITION } as any);
});

describe("POST /api/reports/:id/embed-token — blocks hidden by role", () => {
  it("refuses a viewer: an embed token is a public link, the same role as sharing (SEC-12)", async () => {
    h.user = { ...h.user, role: "viewer" };
    expect((await mint("k_open")).status).toBe(403);
  });

  it("won't mint for a block hidden from the caller, and says it isn't there", async () => {
    const res = await mint("k_fin");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Block not found in this report" });
  });

  it("won't mint for a gated block even for a caller who can see it: the embed is public", async () => {
    h.user = { ...h.user, role: "admin" };
    const res = await mint("k_fin");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("limited to certain roles");
  });

  it("still 404s a block id that only appears as text elsewhere in the definition", async () => {
    // The old substring check passed any string found in the JSON, e.g. a query id.
    expect((await mint("q")).status).toBe(404);
  });

  it("mints for a block everyone can see, and the token works only as an embed token", async () => {
    const res = await mint("k_open");
    expect(res.status).toBe(200);
    const { token, url } = await res.json();
    expect(url).toContain("/embed/block/r1/k_open?token=");
    expect(verifyEmbedToken(token)).toMatchObject({ t: "t1", r: "r1", b: "k_open" });
    // Same signing key as render tokens, which it used to pass for.
    expect(verifyRenderToken(token, "r1")).toBeNull();
  });
});
