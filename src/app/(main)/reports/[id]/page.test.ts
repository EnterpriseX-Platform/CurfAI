/**
 * A print render with no session (an API key's PDF, a scheduled delivery,
 * either one's XLSX chart capture) ran the report with `viewer: undefined`,
 * which the runner treats as the system: no data-source ACL, no lake
 * redaction. It now runs as the viewer its render token names. A session,
 * when there is one, still decides, so a token can't widen what a signed-in
 * person sees.
 *
 * Role-gated blocks follow the token too. An on-demand export's token asks
 * for its viewer's blocks, so an admin API key's PDF has the gated blocks its
 * XLSX/DOCX/CSV have. A delivery's token doesn't, and its blocks filter as a
 * viewer with no roles, as they always did, so no delivery gains blocks.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ session: null as any, roles: [] as string[] }));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
  redirect: vi.fn((to: string) => { throw new Error("NEXT_REDIRECT " + to); }),
}));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }) }));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(async () => null) },
    tenant: { findUnique: vi.fn(async () => null) },
    report: { findFirst: vi.fn() },
    reportRun: { create: vi.fn(async () => ({})) },
  },
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getSession: vi.fn(async () => h.session), getUserRoles: vi.fn(async () => h.roles) };
});
vi.mock("@/lib/reporting/runner", () => ({
  runReportWithProof: vi.fn(async () => ({ dataset: {}, provenance: {} })),
}));
vi.mock("@/ee", () => ({ ee: {} }));
vi.mock("@/components/reports/ReportDocument", () => ({ ReportDocument: () => null }));
vi.mock("./ReportViewerShell", () => ({ ReportViewerShell: () => null }));
vi.mock("@/lib/i18n/dict", () => ({ LOCALES: ["en", "th"] }));

import { prisma } from "@/lib/db";
import { runReportWithProof } from "@/lib/reporting/runner";
import { mintRenderToken } from "@/lib/reporting/renderToken";
import { signCapabilityToken } from "@/lib/security/capabilityToken";
import ViewerPage from "./page";

const block = (id: string, visibleToRoles?: string[]) => ({ id, type: "divider", x: 0, y: 0, w: 12, h: 1, config: {}, visibleToRoles });
const DEFINITION = JSON.stringify({
  version: 1, name: "Sales", parameters: [], dataSources: [],
  pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks: [block("open"), block("finance-only", ["finance"])] }],
});
const DEV = { id: "u-dev", isAdmin: false, roles: ["finance"] };
const ADMIN = { id: "u-admin", isAdmin: true, roles: [] };

const printWith = (rt: string) => ViewerPage({ params: { id: "r1" }, searchParams: { print: "1", rt } }) as Promise<any>;
const ranAs = () => vi.mocked(runReportWithProof).mock.calls[0][0].viewer;
/** Block ids the print page handed to ReportDocument. */
const printedBlocks = (el: any): string[] => el.props.children.props.report.pages[0].blocks.map((b: any) => b.id);

beforeEach(() => {
  vi.clearAllMocks();
  h.session = null;
  h.roles = [];
  vi.mocked(prisma.report.findFirst).mockResolvedValue({ id: "r1", tenantId: "t1", definition: DEFINITION } as any);
});

describe("report viewer page — who a print render runs as", () => {
  it("with no session, runs the report as the viewer the render token names", async () => {
    await printWith(mintRenderToken({ tenantId: "t1", reportId: "r1", viewer: DEV }));
    expect(ranAs()).toEqual(DEV);
    expect(vi.mocked(prisma.report.findFirst).mock.calls[0][0]).toMatchObject({ where: { id: "r1", tenantId: "t1" } });
  });

  it("refuses a signed token that names no viewer instead of running as the system", async () => {
    const legacy = signCapabilityToken({ k: "render", t: "t1", r: "r1", exp: Date.now() + 60_000 });
    await expect(printWith(legacy)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(runReportWithProof).not.toHaveBeenCalled();
  });

  it("a signed-in session decides over the token, so the token can't widen it", async () => {
    h.session = { user: { id: "u-viewer", role: "viewer", tenantId: "t1" } };
    await printWith(mintRenderToken({ tenantId: "t1", reportId: "r1", viewer: ADMIN }));
    expect(ranAs()).toEqual({ id: "u-viewer", isAdmin: false, roles: [] });
  });

  it("filters role-gated blocks as a viewer with no roles for a token that doesn't ask for its viewer's", async () => {
    // A scheduled delivery's token. An admin's delivery never carried
    // role-gated blocks, and running blocks as the token's viewer would add them.
    const el = await printWith(mintRenderToken({ tenantId: "t1", reportId: "r1", viewer: ADMIN }));
    expect(printedBlocks(el)).toEqual(["open"]);
  });

  it("shows the token viewer's blocks for an on-demand export, the same ones its XLSX/DOCX/CSV have", async () => {
    // An admin API key's PDF used to drop the gated block while its XLSX kept
    // it, so the XLSX's chart capture waited for a block the page never drew.
    const admin = await printWith(mintRenderToken({ tenantId: "t1", reportId: "r1", viewer: ADMIN, blocksAsViewer: true }));
    expect(printedBlocks(admin)).toEqual(["open", "finance-only"]);
    const noRoles = await printWith(mintRenderToken({ tenantId: "t1", reportId: "r1", viewer: { id: "apikey:k1", isAdmin: false, roles: [] }, blocksAsViewer: true }));
    expect(printedBlocks(noRoles)).toEqual(["open"]);
  });

  it("a signed-in session decides blocks over the token too", async () => {
    h.session = { user: { id: "u-viewer", role: "viewer", tenantId: "t1" } };
    const el = await printWith(mintRenderToken({ tenantId: "t1", reportId: "r1", viewer: ADMIN, blocksAsViewer: true }));
    expect(printedBlocks(el)).toEqual(["open"]);
  });
});
