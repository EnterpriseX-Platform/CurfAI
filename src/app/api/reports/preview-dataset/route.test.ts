/**
 * Any signed-in caller could run arbitrary SQL through the designer's
 * preview endpoints, and the report ran as the system: a viewer-role API key
 * got rows from role-restricted and owner-only sources. The route is now
 * builder-only (admin / developer) and runs the unsaved report as the
 * caller, so a source their role can't see comes back empty as in the viewer.
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
  runReport: vi.fn(async () => ({ q: [{ region: "North", revenue: 100 }, { region: "South", revenue: 80 }] })),
}));

import { runReport } from "@/lib/reporting/runner";
import { POST } from "./route";

const REPORT = {
  version: 1, name: "Revenue", parameters: [],
  dataSources: [{ id: "q", name: "Revenue", dataSourceId: "ds1", sql: "SELECT region, SUM(amount) AS revenue FROM sales GROUP BY 1" }],
  pages: [{
    id: "p1", size: "A4", orientation: "portrait",
    blocks: [{ id: "b1", type: "kpi", x: 0, y: 0, w: 4, h: 3, config: { queryId: "q", label: "Revenue", valueField: "revenue", format: "number" } }],
  }],
};
const post = () => POST(
  new NextRequest("http://localhost:3100/api/reports/preview-dataset", {
    method: "POST",
    body: JSON.stringify({ report: REPORT, params: { year: 2026 } }),
    headers: { "content-type": "application/json" },
  }),
);

beforeEach(() => {
  vi.clearAllMocks();
  h.user = { id: "u-dev", email: "d@test.dev", role: "developer", tenantId: "t1" };
  h.roles = [];
});

describe("POST /api/reports/preview-dataset — builders only", () => {
  it("refuses a viewer-role session and never runs the report", async () => {
    h.user = { id: "u-viewer", email: "v@test.dev", role: "viewer", tenantId: "t1" };
    expect((await post()).status).toBe(403);
    expect(runReport).not.toHaveBeenCalled();
  });

  it("refuses a viewer-role API key", async () => {
    h.user = { id: "apikey:k1", email: "apikey+curf_x@curf.local", role: "viewer", tenantId: "t1", viaApiKey: true, apiKeyId: "k1" };
    expect((await post()).status).toBe(403);
    expect(runReport).not.toHaveBeenCalled();
  });

  it("refuses an executive", async () => {
    h.user = { id: "u-exec", email: "e@test.dev", role: "executive", tenantId: "t1" };
    expect((await post()).status).toBe(403);
    expect(runReport).not.toHaveBeenCalled();
  });
});

describe("POST /api/reports/preview-dataset — runs as the caller", () => {
  it("a developer runs the unsaved report as themselves and gets the dataset back", async () => {
    h.roles = ["finance"];
    const res = await post();
    expect(res.status).toBe(200);
    expect(vi.mocked(runReport).mock.calls[0][0]).toMatchObject({
      report: { name: "Revenue" },
      params: { year: 2026 },
      viewer: { id: "u-dev", isAdmin: false, roles: ["finance"] },
    });
    expect(await res.json()).toMatchObject({
      dataset: { q: [{ region: "North", revenue: 100 }, { region: "South", revenue: 80 }] },
      summary: { q: { rows: 2 } },
    });
  });
});
