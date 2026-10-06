/**
 * Any signed-in caller could run arbitrary SQL through the designer's
 * preview endpoints, and the query ran as the system: a viewer-role API key
 * got rows from role-restricted and owner-only sources. The route is now
 * builder-only (admin / developer) and runs the query as the caller, so a
 * source they can't see is refused with the runner's "Hidden by visibility" note.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ user: null as any, roles: [] as string[] }));

vi.mock("@/lib/db", () => ({ prisma: {} }));
// The real requireAdminOrEditor() calls auth.ts's own requireUser(), which a
// mocked export can't reach, so it is stubbed here with the same 401/403
// rules. The real blockScopedApiKey() runs.
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  const { NextResponse } = await import("next/server");
  return {
    ...actual,
    requireUser: vi.fn(async () => h.user),
    getUserRoles: vi.fn(async () => h.roles),
    requireAdminOrEditor: vi.fn(async () => {
      if (!h.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (h.user.role !== "admin" && h.user.role !== "developer") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      return h.user;
    }),
  };
});
vi.mock("@/lib/reporting/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reporting/runner")>()),
  runSingleQuery: vi.fn(async () => [{ region: "North", revenue: 100 }, { region: "South", revenue: 80 }]),
}));

import { getUserRoles } from "@/lib/auth";
import { runSingleQuery } from "@/lib/reporting/runner";
import { POST } from "./route";

const QUERY = { id: "q", name: "Revenue", dataSourceId: "ds1", sql: "SELECT region, SUM(amount) AS revenue FROM sales GROUP BY 1" };
const post = (body: unknown = { query: QUERY, params: { year: 2026 } }) => POST(
  new NextRequest("http://localhost:3100/api/reports/preview-query", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  }),
);

beforeEach(() => {
  vi.clearAllMocks();
  h.user = { id: "u-dev", email: "d@test.dev", role: "developer", tenantId: "t1" };
  h.roles = [];
});

describe("POST /api/reports/preview-query — builders only", () => {
  it("refuses a viewer-role session and never runs the query", async () => {
    h.user = { id: "u-viewer", email: "v@test.dev", role: "viewer", tenantId: "t1" };
    expect((await post()).status).toBe(403);
    expect(runSingleQuery).not.toHaveBeenCalled();
  });

  it("refuses a viewer-role API key", async () => {
    h.user = { id: "apikey:k1", email: "apikey+curf_x@curf.local", role: "viewer", tenantId: "t1", viaApiKey: true, apiKeyId: "k1" };
    expect((await post()).status).toBe(403);
    expect(runSingleQuery).not.toHaveBeenCalled();
  });

  it("refuses an executive", async () => {
    h.user = { id: "u-exec", email: "e@test.dev", role: "executive", tenantId: "t1" };
    expect((await post()).status).toBe(403);
    expect(runSingleQuery).not.toHaveBeenCalled();
  });

  it("refuses a report-scoped key even with a builder role", async () => {
    h.user = { id: "apikey:k2", email: "apikey+curf_y@curf.local", role: "developer", tenantId: "t1", viaApiKey: true, apiKeyId: "k2", scopedReportIds: ["r1"] };
    expect((await post()).status).toBe(403);
    expect(runSingleQuery).not.toHaveBeenCalled();
  });
});

describe("POST /api/reports/preview-query — runs as the caller", () => {
  it("a developer runs the query as themselves, custom roles included", async () => {
    h.roles = ["finance"];
    const res = await post();
    expect(res.status).toBe(200);
    expect(vi.mocked(runSingleQuery).mock.calls[0]).toEqual([
      QUERY, { year: 2026 }, { id: "u-dev", isAdmin: false, roles: ["finance"] }, "t1",
    ]);
    expect(await res.json()).toMatchObject({
      rows: [{ region: "North", revenue: 100 }, { region: "South", revenue: 80 }],
      totalRows: 2, truncated: false, columns: ["region", "revenue"],
    });
  });

  it("an admin API key runs as the key: admin, but no role slugs", async () => {
    h.user = { id: "apikey:k1", email: "apikey+curf_x@curf.local", role: "admin", tenantId: "t1", viaApiKey: true, apiKeyId: "k1" };
    expect((await post()).status).toBe(200);
    expect(vi.mocked(runSingleQuery).mock.calls[0][2]).toEqual({ id: "apikey:k1", isAdmin: true, roles: [] });
    expect(getUserRoles).not.toHaveBeenCalled();
  });

  it("a source the caller can't see answers 400 with the runner's visibility note", async () => {
    vi.mocked(runSingleQuery).mockRejectedValueOnce(new Error("Hidden by visibility — you don't have access to this source."));
    const res = await post();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Hidden by visibility — you don't have access to this source." });
  });
});
