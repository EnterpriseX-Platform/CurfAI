/**
 * The PDF export forwards the caller's session cookie to the headless
 * viewer. An API key has no cookie, so the page ran the report as the
 * system: a viewer-role key got PDFs with data from role-restricted and
 * owner-only sources that its XLSX/CSV/DOCX exports correctly left out.
 * The route now hands renderPdf() the caller's viewer, which travels in the
 * render token.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ user: null as any, roles: [] as string[] }));

vi.mock("@/lib/db", () => ({
  prisma: {
    report: { findFirst: vi.fn() },
    reportRun: { create: vi.fn(async () => ({})) },
  },
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireUser: vi.fn(async () => h.user), getUserRoles: vi.fn(async () => h.roles) };
});
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/reporting/renderers/pdf", () => ({ renderPdf: vi.fn(async () => Buffer.from("%PDF")) }));
vi.mock("@/lib/reporting/renderers/headlessBrowser", () => ({ browserBusyResponse: vi.fn(() => null) }));

import { prisma } from "@/lib/db";
import { getUserRoles } from "@/lib/auth";
import { renderPdf } from "@/lib/reporting/renderers/pdf";
import { GET } from "./route";

const DEFINITION = JSON.stringify({
  version: 1, name: "Sales", parameters: [], dataSources: [],
  pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks: [] }],
});
const get = (cookie?: string) => GET(
  new NextRequest("http://localhost:3100/api/reports/r1/export/pdf", { headers: cookie ? { cookie } : undefined }),
  { params: { id: "r1" } },
);

beforeEach(() => {
  vi.clearAllMocks();
  h.roles = [];
  vi.mocked(prisma.report.findFirst).mockResolvedValue({ id: "r1", tenantId: "t1", name: "Sales", definition: DEFINITION } as any);
});

describe("GET /api/reports/:id/export/pdf — renders as the caller", () => {
  it("a viewer-role API key renders as the key: no admin bypass, no role slugs, no cookie", async () => {
    h.user = { id: "apikey:k1", email: "apikey+curf_x@curf.local", role: "viewer", tenantId: "t1", viaApiKey: true, apiKeyId: "k1" };
    expect((await get()).status).toBe(200);
    expect(vi.mocked(renderPdf).mock.calls[0][0]).toMatchObject({
      reportId: "r1", tenantId: "t1", authCookie: undefined,
      viewer: { id: "apikey:k1", isAdmin: false, roles: [] },
    });
    expect(getUserRoles).not.toHaveBeenCalled();
  });

  it("an admin-role API key's PDF shows the blocks the key may see, like its XLSX/DOCX/CSV", async () => {
    // The page used to filter blocks as nobody for every key, so an admin
    // key's PDF lacked the role-gated blocks its other formats carried.
    h.user = { id: "apikey:k2", email: "apikey+curf_y@curf.local", role: "admin", tenantId: "t1", viaApiKey: true, apiKeyId: "k2" };
    expect((await get()).status).toBe(200);
    expect(vi.mocked(renderPdf).mock.calls[0][0]).toMatchObject({
      viewer: { id: "apikey:k2", isAdmin: true, roles: [] },
      blocksAsViewer: true,
    });
  });

  it("a session user renders as themselves, cookie and custom roles both", async () => {
    h.user = { id: "u-dev", email: "d@test.dev", role: "developer", tenantId: "t1" };
    h.roles = ["finance"];
    expect((await get("next-auth.session-token=abc")).status).toBe(200);
    expect(vi.mocked(renderPdf).mock.calls[0][0]).toMatchObject({
      authCookie: "next-auth.session-token=abc",
      viewer: { id: "u-dev", isAdmin: false, roles: ["finance"] },
    });
  });
});
