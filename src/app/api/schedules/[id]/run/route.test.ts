/**
 * A report-scoped API key (ApiKey.scopedReportIds) could POST this route
 * with the id of a schedule on a report OUTSIDE its allowlist and get that
 * report rendered and returned inline — the lookup was tenant-scoped only,
 * never checked against the key's allowlist.
 *
 * It also rendered with no caller identity, so the file skipped the
 * data-source ACL and lake redaction the caller would get from
 * /api/reports/:id/export/*, and it ran any Schedule row regardless of
 * kind, watchers and digests included.
 *
 * The real tenantWhere() / requireReportInScope() run here; only the caller
 * identity (and the custom role slugs a session would read) is stubbed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ user: null as any, roles: [] as string[] }));

vi.mock("@/lib/db", () => ({
  prisma: {
    schedule: { findFirst: vi.fn(), update: vi.fn(async () => ({})) },
  },
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireUser: vi.fn(async () => h.user), getUserRoles: vi.fn(async () => h.roles) };
});
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/reporting/runner", () => ({ runReport: vi.fn() }));
vi.mock("@/lib/reporting/renderers/pdf", () => ({ renderPdf: vi.fn(async () => Buffer.from("%PDF")) }));
vi.mock("@/lib/reporting/renderers/xlsx", () => ({ renderXlsx: vi.fn(async () => Buffer.from("xlsx")) }));
vi.mock("@/lib/reporting/renderers/docx", () => ({ renderDocx: vi.fn(async () => Buffer.from("docx")) }));
vi.mock("@/lib/reporting/renderers/csv", () => ({ renderCsv: vi.fn(async () => "region,revenue\nNorth,100\n") }));
vi.mock("@/lib/reporting/renderers/headlessBrowser", () => ({ browserBusyResponse: vi.fn(() => null) }));

import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { getUserRoles } from "@/lib/auth";
import { runReport } from "@/lib/reporting/runner";
import { renderPdf } from "@/lib/reporting/renderers/pdf";
import { renderXlsx } from "@/lib/reporting/renderers/xlsx";
import { renderDocx } from "@/lib/reporting/renderers/docx";
import { renderCsv } from "@/lib/reporting/renderers/csv";
import { POST } from "./route";

const DEFINITION = JSON.stringify({
  version: 1, name: "P&L", parameters: [], dataSources: [],
  pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks: [] }],
});

const scheduleOn = (reportId: string, format = "csv") => ({
  id: "s1", tenantId: "t1", kind: "delivery", reportId, format, params: "{}",
  report: { id: reportId, name: "P&L", definition: DEFINITION },
});
const run = (cookie?: string) => POST(
  new NextRequest("http://localhost:3100/api/schedules/s1/run", {
    method: "POST",
    headers: cookie ? { cookie } : undefined,
  }),
  { params: { id: "s1" } },
);
const scopedKey = (scopedReportIds: string[]) => ({
  id: "apikey:k1", email: "apikey+curf_x@curf.local", role: "viewer", tenantId: "t1",
  viaApiKey: true, apiKeyId: "k1", scopedReportIds,
});
const viewerSession = { id: "u-viewer", email: "v@test.dev", role: "viewer", tenantId: "t1" };

beforeEach(() => {
  vi.clearAllMocks();
  h.user = { id: "u1", email: "a@test.dev", role: "admin", tenantId: "t1" };
  h.roles = [];
});

describe("POST /api/schedules/:id/run — report-scoped API keys", () => {
  it("looks the schedule up tenant-scoped, delivery schedules only", async () => {
    vi.mocked(prisma.schedule.findFirst).mockResolvedValue(scheduleOn("rA") as any);
    await run();
    expect(vi.mocked(prisma.schedule.findFirst).mock.calls[0][0]).toMatchObject({
      where: { id: "s1", kind: "delivery", tenantId: "t1" },
    });
  });

  it("404s a schedule on a report outside the key's allowlist, before rendering anything", async () => {
    h.user = scopedKey(["rA"]);
    vi.mocked(prisma.schedule.findFirst).mockResolvedValue(scheduleOn("rB") as any);
    const res = await run();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
    expect(renderCsv).not.toHaveBeenCalled();
    expect(prisma.schedule.update).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("still runs a schedule on an allowlisted report", async () => {
    h.user = scopedKey(["rA"]);
    vi.mocked(prisma.schedule.findFirst).mockResolvedValue(scheduleOn("rA") as any);
    const res = await run();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(renderCsv).toHaveBeenCalledTimes(1);
  });

  it("leaves session users and unscoped keys unrestricted", async () => {
    vi.mocked(prisma.schedule.findFirst).mockResolvedValue(scheduleOn("rB") as any);
    expect((await run()).status).toBe(200);
    h.user = { ...scopedKey([]), scopedReportIds: undefined };
    expect((await run()).status).toBe(200);
  });
});

describe("POST /api/schedules/:id/run — renders as the caller", () => {
  it("lets a viewer run it, and the CSV runs with the viewer's identity and role slugs", async () => {
    h.user = viewerSession;
    h.roles = ["finance"];
    vi.mocked(prisma.schedule.findFirst).mockResolvedValue(scheduleOn("rA", "csv") as any);
    expect((await run()).status).toBe(200);
    expect(vi.mocked(renderCsv).mock.calls[0][2]).toEqual({ tenantId: "t1", viewer: { id: "u-viewer", isAdmin: false, roles: ["finance"] } });
  });

  it("DOCX gets the caller's identity too", async () => {
    h.user = viewerSession;
    vi.mocked(prisma.schedule.findFirst).mockResolvedValue(scheduleOn("rA", "docx") as any);
    expect((await run()).status).toBe(200);
    expect(vi.mocked(renderDocx).mock.calls[0][2]).toEqual({ tenantId: "t1", viewer: { id: "u-viewer", isAdmin: false, roles: [] } });
  });

  it("XLSX gets the caller's identity and session cookie (its chart capture opens the viewer page)", async () => {
    h.user = viewerSession;
    vi.mocked(prisma.schedule.findFirst).mockResolvedValue(scheduleOn("rA", "xlsx") as any);
    expect((await run("next-auth.session-token=abc")).status).toBe(200);
    expect(vi.mocked(renderXlsx).mock.calls[0][2]).toMatchObject({
      viewer: { id: "u-viewer", isAdmin: false, roles: [] },
      authCookie: "next-auth.session-token=abc",
    });
  });

  it("PDF forwards the caller's session cookie and locale to the headless viewer", async () => {
    h.user = viewerSession;
    vi.mocked(prisma.schedule.findFirst).mockResolvedValue(scheduleOn("rA", "pdf") as any);
    expect((await run("__Secure-next-auth.session-token=xyz; rd_locale=th")).status).toBe(200);
    expect(vi.mocked(renderPdf).mock.calls[0][0]).toMatchObject({
      authCookie: "__Secure-next-auth.session-token=xyz",
      locale: "th",
      viewer: { id: "u-viewer", isAdmin: false, roles: [] },
    });
  });

  it("an API key renders as the key, with no role slugs and no session lookup", async () => {
    h.user = { ...scopedKey([]), scopedReportIds: undefined };
    vi.mocked(prisma.schedule.findFirst).mockResolvedValue(scheduleOn("rA", "csv") as any);
    expect((await run()).status).toBe(200);
    expect(vi.mocked(renderCsv).mock.calls[0][2]).toEqual({ tenantId: "t1", viewer: { id: "apikey:k1", isAdmin: false, roles: [] } });
    expect(getUserRoles).not.toHaveBeenCalled();
  });

  it("an API key's PDF renders as the key too, pre-warm run included", async () => {
    // A key has no cookie to forward, so the viewer page used to run the
    // report as the system, with no data-source ACL. It now gets the key's
    // identity from the render token.
    h.user = { ...scopedKey([]), scopedReportIds: undefined };
    vi.mocked(prisma.schedule.findFirst).mockResolvedValue(scheduleOn("rA", "pdf") as any);
    expect((await run()).status).toBe(200);
    const key = { id: "apikey:k1", isAdmin: false, roles: [] };
    expect(vi.mocked(runReport).mock.calls[0][0]).toMatchObject({ viewer: key });
    expect(vi.mocked(renderPdf).mock.calls[0][0]).toMatchObject({ authCookie: undefined, viewer: key });
  });

  it("the PDF shows the caller's blocks, as the other formats here do", async () => {
    // Run now hands the file to the caller. The cron's delivery of the same
    // schedule doesn't pass this, and filters blocks as nobody.
    h.user = { ...scopedKey([]), role: "admin", scopedReportIds: undefined };
    vi.mocked(prisma.schedule.findFirst).mockResolvedValue(scheduleOn("rA", "pdf") as any);
    expect((await run()).status).toBe(200);
    expect(vi.mocked(renderPdf).mock.calls[0][0]).toMatchObject({
      viewer: { id: "apikey:k1", isAdmin: true, roles: [] },
      blocksAsViewer: true,
    });
  });
});
