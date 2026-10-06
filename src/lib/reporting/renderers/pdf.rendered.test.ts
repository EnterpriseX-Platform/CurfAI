/**
 * renderPdf() printed whatever the page showed. page.goto() doesn't throw
 * on a not-found page, and since (main)/loading.tsx streams every page, a
 * notFound() answers HTTP 200 as well — so a missing or unauthorised report
 * came out as a PDF of the "page could not be found" screen, and a
 * scheduled delivery would email it as if it were the report.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const page = {
  goto: vi.fn(async () => null),
  waitForSelector: vi.fn(),
  waitForFunction: vi.fn(async () => ({})),
  evaluate: vi.fn(async () => undefined),
  setCookie: vi.fn(async () => undefined),
  pdf: vi.fn(async () => new Uint8Array([37, 80, 68, 70])), // "%PDF"
};
const context = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) };
const browser = { connected: true, createBrowserContext: vi.fn(async () => context), once: vi.fn(), close: vi.fn(async () => undefined) };
vi.mock("puppeteer", () => ({ default: { launch: vi.fn(async () => browser) } }));
vi.mock("@/lib/http/appBase", () => ({ internalBase: () => "http://127.0.0.1:3100" }));
vi.mock("@/lib/reporting/renderers/puppeteerAuth", () => ({ setSessionCookie: vi.fn(async () => undefined) }));
vi.mock("@/lib/reporting/renderToken", () => ({ mintRenderToken: () => "rt" }));

import { renderPdf } from "./pdf";

beforeEach(() => vi.clearAllMocks());

describe("renderPdf — only prints a page that rendered the report", () => {
  it("fails instead of printing when the report never rendered", async () => {
    page.waitForSelector.mockRejectedValueOnce(new Error("timeout"));
    await expect(renderPdf({ reportId: "r1", tenantId: "t1" } as any)).rejects.toThrow(/did not render/);
    expect(page.pdf).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalled();
  });

  it("prints once the report root is on the page", async () => {
    page.waitForSelector.mockResolvedValueOnce({});
    const out = await renderPdf({ reportId: "r1", tenantId: "t1" } as any);
    expect(page.waitForSelector).toHaveBeenCalledWith(".report-doc", expect.anything());
    expect(page.pdf).toHaveBeenCalled();
    expect(out.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("fails instead of printing blank chart cards when the charts never finish drawing", async () => {
    // Seen under load: the page had not hydrated yet, so every Recharts
    // container was still empty, and the export answered 200 anyway.
    page.waitForSelector.mockResolvedValueOnce({});
    page.waitForFunction.mockRejectedValueOnce(new Error("timeout"));
    await expect(renderPdf({ reportId: "r1", tenantId: "t1" } as any)).rejects.toThrow(/charts never finished drawing/);
    expect(page.pdf).not.toHaveBeenCalled();
  });
});
