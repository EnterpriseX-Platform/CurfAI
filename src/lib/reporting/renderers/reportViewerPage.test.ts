/**
 * The PDF export and the XLSX chart capture open the report's viewer page
 * headless. An API key or the cron has no session cookie to send, so the
 * render token is all the page knows about who asked. It used to name only
 * the tenant, and the page ran the report as the system: no data-source ACL,
 * no lake redaction. The token now carries the viewer, and a navigation
 * that can't name one gets no token at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/http/appBase", () => ({ internalBase: () => "http://127.0.0.1:3100" }));
vi.mock("@/lib/reporting/renderers/puppeteerAuth", () => ({ setSessionCookie: vi.fn(async () => undefined) }));

import { openReportViewer } from "./reportViewerPage";
import { verifyRenderToken } from "@/lib/reporting/renderToken";

const page = {
  goto: vi.fn(async (_url: string, _opts?: unknown) => null),
  waitForSelector: vi.fn(async () => ({})),
  waitForFunction: vi.fn(async () => ({})),
  evaluate: vi.fn(async () => undefined),
  setCookie: vi.fn(async () => undefined),
};

const openedUrl = () => new URL(page.goto.mock.calls[0][0]);

beforeEach(() => vi.clearAllMocks());

describe("openReportViewer — the render token names who the report runs as", () => {
  it("mints a token for this report, in this tenant, as this viewer", async () => {
    const viewer = { id: "apikey:k1", isAdmin: false, roles: [] };
    await openReportViewer(page as any, "PDF export", { reportId: "r1", tenantId: "t1", viewer, params: { from: "2025-06-01" } });
    const url = openedUrl();
    expect(url.pathname).toBe("/reports/r1");
    expect(url.searchParams.get("print")).toBe("1");
    expect(url.searchParams.get("p.from")).toBe("2025-06-01");
    expect(verifyRenderToken(url.searchParams.get("rt"), "r1")).toEqual({ tenantId: "t1", viewer, blocksAsViewer: false });
  });

  it("asks the page for the viewer's blocks only when the caller says so", async () => {
    const viewer = { id: "apikey:k1", isAdmin: true, roles: [] };
    await openReportViewer(page as any, "PDF export", { reportId: "r1", tenantId: "t1", viewer, blocksAsViewer: true, params: {} });
    expect(verifyRenderToken(openedUrl().searchParams.get("rt"), "r1")?.blocksAsViewer).toBe(true);
  });

  it("mints no token without a viewer, so only a forwarded session can render", async () => {
    // A token with a tenant and no one in it was the system render. The
    // page now refuses that shape, and this side never produces it.
    await openReportViewer(page as any, "XLSX export", { reportId: "r1", tenantId: "t1", params: {}, authCookie: "next-auth.session-token=abc" });
    expect(openedUrl().searchParams.has("rt")).toBe(false);
  });
});
