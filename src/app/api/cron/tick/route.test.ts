/**
 * Scheduled deliveries rendered with no viewer, which the runner reads as
 * the system: no data-source ACL, no lake redaction. So a developer could
 * schedule a report and have it emailed out with data from role-restricted
 * or owner-only sources they can't see themselves. Every format now renders
 * as the schedule's creator (lib/reporting/exportCaller.ts deliveryViewer()),
 * the PDF's pre-warm run included. Role-gated blocks still filter as nobody,
 * as the scheduled PDF's page does.
 *
 * The real deliveryViewer() runs here against a stubbed Membership row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    schedule: { findMany: vi.fn(), update: vi.fn(async () => ({})) },
    report: { findUnique: vi.fn() },
    membership: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/rateLimit", () => ({ ensureLimit: vi.fn(() => null) }));
vi.mock("@/lib/delivery/dispatch", () => ({
  dispatchDelivery: vi.fn(async () => ({ status: "delivered", destination: "log", message: "ok" })),
  parseDeliveryConfig: vi.fn(() => ({ kind: "log" })),
}));
vi.mock("@/lib/reporting/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reporting/runner")>()),
  runReport: vi.fn(async () => ({})),
}));
vi.mock("@/lib/reporting/renderers/pdf", () => ({ renderPdf: vi.fn(async () => Buffer.from("%PDF")) }));
vi.mock("@/lib/reporting/renderers/xlsx", () => ({ renderXlsx: vi.fn(async () => Buffer.from("xlsx")) }));
vi.mock("@/lib/reporting/renderers/docx", () => ({ renderDocx: vi.fn(async () => Buffer.from("docx")) }));
vi.mock("@/lib/reporting/renderers/csv", () => ({ renderCsv: vi.fn(async () => "a\n1\n") }));
vi.mock("@/lib/cron/lakeTicks", () => ({
  tickLakePulls: vi.fn(), tickMaterializedViews: vi.fn(), tickLakeBackups: vi.fn(), tickBackupSnapshots: vi.fn(),
}));
vi.mock("@/lib/cron/opsTicks", () => ({
  tickAuditRetention: vi.fn(), tickAiUsageThreshold: vi.fn(), tickSecurityAlerts: vi.fn(),
}));
vi.mock("@/ee", () => ({ ee: {} }));

import { prisma } from "@/lib/db";
import { runReport, ANONYMOUS_VIEWER } from "@/lib/reporting/runner";
import { renderPdf } from "@/lib/reporting/renderers/pdf";
import { renderXlsx } from "@/lib/reporting/renderers/xlsx";
import { renderDocx } from "@/lib/reporting/renderers/docx";
import { renderCsv } from "@/lib/reporting/renderers/csv";
import { POST } from "./route";

const DEFINITION = JSON.stringify({
  version: 1, name: "P&L", parameters: [], dataSources: [],
  pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks: [] }],
});
const divider = (id: string, visibleToRoles?: string[]) => ({ id, type: "divider", x: 0, y: 0, w: 12, h: 1, config: {}, visibleToRoles });
const GATED = JSON.stringify({
  version: 1, name: "P&L", parameters: [], dataSources: [],
  pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks: [divider("open"), divider("exec-only", ["executive"])] }],
});
const CREATOR = { id: "u-dev", isAdmin: false, roles: ["finance"] };

const delivery = (format: string) => ({
  id: "s1", tenantId: "t1", kind: "delivery", reportId: "r1", format, cron: "0 8 * * *",
  params: '{"from":"2025-06-01"}', recipients: "[]", deliveryConfigJson: null, createdById: "u-dev",
});
const tick = () => POST(new NextRequest("http://localhost:3100/api/cron/tick?force=1", {
  method: "POST", headers: { "x-cron-secret": "cron-secret" },
}));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "cron-secret";
  vi.mocked(prisma.report.findUnique).mockResolvedValue({ id: "r1", name: "P&L", definition: DEFINITION } as any);
  vi.mocked(prisma.membership.findUnique).mockResolvedValue({ role: "developer", rolesJson: '["finance"]' } as any);
});

describe("cron tick — a scheduled delivery renders as its creator", () => {
  it("PDF: the pre-warm run and the headless viewer both get the creator", async () => {
    vi.mocked(prisma.schedule.findMany).mockResolvedValue([delivery("pdf")] as any);
    await tick();
    expect(vi.mocked(runReport).mock.calls[0][0]).toMatchObject({ tenantId: "t1", viewer: CREATOR });
    expect(vi.mocked(renderPdf).mock.calls[0][0]).toMatchObject({ reportId: "r1", tenantId: "t1", viewer: CREATOR });
  });

  it("XLSX: the data run and its chart capture get the creator", async () => {
    vi.mocked(prisma.schedule.findMany).mockResolvedValue([delivery("xlsx")] as any);
    await tick();
    expect(vi.mocked(renderXlsx).mock.calls[0][2]).toMatchObject({ reportId: "r1", tenantId: "t1", viewer: CREATOR });
  });

  it("DOCX and CSV get the creator", async () => {
    vi.mocked(prisma.schedule.findMany).mockResolvedValue([delivery("docx"), delivery("csv")] as any);
    await tick();
    expect(vi.mocked(renderDocx).mock.calls[0][2]).toEqual({ tenantId: "t1", viewer: CREATOR });
    expect(vi.mocked(renderCsv).mock.calls[0][2]).toEqual({ tenantId: "t1", viewer: CREATOR });
  });

  it("still leaves role-gated blocks out of an admin's delivery: the creator decides data, not blocks", async () => {
    // The scheduled PDF's page filters blocks as nobody. Filtering the other
    // formats as an admin creator would add blocks those emails never had,
    // and a gated chart the capture page doesn't draw would fail the XLSX.
    vi.mocked(prisma.membership.findUnique).mockResolvedValue({ role: "admin", rolesJson: "[]" } as any);
    vi.mocked(prisma.report.findUnique).mockResolvedValue({ id: "r1", name: "P&L", definition: GATED } as any);
    vi.mocked(prisma.schedule.findMany).mockResolvedValue([delivery("xlsx")] as any);
    await tick();
    const [report, , opts] = vi.mocked(renderXlsx).mock.calls[0];
    expect(report.pages[0].blocks.map((b) => b.id)).toEqual(["open"]);
    expect(opts).toMatchObject({ viewer: { id: "u-dev", isAdmin: true, roles: [] } });
  });

  it("an admin's scheduled PDF doesn't ask the page for the creator's blocks", async () => {
    // On-demand exports pass blocksAsViewer, so the page shows the caller's
    // blocks. A delivery must not, or an admin's email gains gated blocks.
    vi.mocked(prisma.membership.findUnique).mockResolvedValue({ role: "admin", rolesJson: "[]" } as any);
    vi.mocked(prisma.report.findUnique).mockResolvedValue({ id: "r1", name: "P&L", definition: GATED } as any);
    vi.mocked(prisma.schedule.findMany).mockResolvedValue([delivery("pdf")] as any);
    await tick();
    const opts = vi.mocked(renderPdf).mock.calls[0][0];
    expect(opts).toMatchObject({ viewer: { id: "u-dev", isAdmin: true, roles: [] } });
    expect(opts.blocksAsViewer).toBeFalsy();
  });

  it("a creator who has left the workspace sends what an anonymous link would show", async () => {
    vi.mocked(prisma.membership.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.schedule.findMany).mockResolvedValue([delivery("pdf")] as any);
    await tick();
    expect(vi.mocked(renderPdf).mock.calls[0][0]).toMatchObject({ viewer: ANONYMOUS_VIEWER });
  });
});
