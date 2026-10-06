/**
 * renderXlsx() used to log a failed chart capture and carry on. Under
 * concurrent exports (2026-09-23) that shipped files with every chart
 * missing, and every one of them answered 200. The same happened when a
 * chart was screenshotted before it had drawn. A capture failure now fails
 * the export. A report with nothing to screenshot never takes a browser.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import ExcelJS from "exceljs";

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const h = vi.hoisted(() => {
  const el = {
    screenshot: vi.fn(async () => ""),
    boundingBox: vi.fn(async () => ({ x: 0, y: 0, width: 400, height: 240 })),
  };
  const page = {
    setViewport: vi.fn(async () => undefined),
    setCookie: vi.fn(async () => undefined),
    goto: vi.fn(async () => null),
    waitForSelector: vi.fn(async () => ({})),
    waitForFunction: vi.fn(async () => ({})),
    evaluate: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
    $: vi.fn(async (): Promise<unknown> => el),
  };
  const context = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) };
  const browser = { connected: true, createBrowserContext: vi.fn(async () => context), once: vi.fn(), close: vi.fn() };
  return { el, page, context, browser, launch: vi.fn(async () => browser) };
});
vi.mock("puppeteer", () => ({ default: { launch: h.launch } }));
vi.mock("@/lib/http/appBase", () => ({ internalBase: () => "http://127.0.0.1:3100" }));
vi.mock("@/lib/reporting/renderToken", () => ({ mintRenderToken: vi.fn(() => "rt") }));
vi.mock("@/lib/reporting/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reporting/runner")>()),
  runReportWithProof: vi.fn(async () => ({ dataset: { q: [{ month: "Jan", revenue: 10 }] }, provenance: { q: {} } })),
}));

import { mintRenderToken } from "@/lib/reporting/renderToken";
import { renderXlsx } from "./xlsx";

const chartBlock = { id: "c1", type: "chart", x: 0, y: 3, w: 12, h: 6, config: { queryId: "q", chartType: "bar", xField: "month", yFields: ["revenue"], title: "Revenue" } };
const kpiBlock = { id: "k1", type: "kpi", x: 0, y: 0, w: 6, h: 3, config: { queryId: "q", label: "Revenue", valueField: "revenue", format: "number" } };
const report = (blocks: any[]): any => ({
  version: 1, name: "Revenue", parameters: [],
  dataSources: [{ id: "q", name: "Q", dataSourceId: "ds1", sql: "SELECT 1" }],
  pages: [{ id: "p1", size: "A4", orientation: "portrait", blocks }],
});
const OPTS = { reportId: "r1", tenantId: "t1" };

beforeEach(() => {
  vi.clearAllMocks();
  h.el.screenshot.mockResolvedValue(PNG_1PX);
  h.page.$.mockResolvedValue(h.el);
  h.page.waitForSelector.mockResolvedValue({});
  h.page.waitForFunction.mockResolvedValue({});
  h.page.evaluate.mockImplementation(async () => undefined);
});

describe("renderXlsx chart capture", () => {
  it("embeds each captured chart", async () => {
    const buf = await renderXlsx(report([kpiBlock, chartBlock]), {}, OPTS);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as any);
    expect(wb.getWorksheet("Report")!.getImages()).toHaveLength(1);
    expect(h.page.$).toHaveBeenCalledWith('[data-block-id="c1"]');
    expect(h.context.close).toHaveBeenCalledTimes(1);
  });

  it("keeps every screenshot inside the viewport, since capturing beyond it blanks the charts mid-shot", async () => {
    await renderXlsx(report([chartBlock]), {}, OPTS);
    expect(h.el.screenshot).toHaveBeenCalledWith(expect.objectContaining({ captureBeyondViewport: false }));
  });

  it("grows the viewport to fit a block taller than it, instead of cropping that block", async () => {
    // The only evaluate() that gets an argument is the one measuring the captured blocks.
    h.page.evaluate.mockImplementation(async (_fn: unknown, arg?: unknown) => (Array.isArray(arg) ? 2400 : undefined));
    await renderXlsx(report([{ ...chartBlock, h: 60 }]), {}, OPTS);
    expect(h.page.setViewport).toHaveBeenLastCalledWith(expect.objectContaining({ width: 900, height: expect.any(Number) }));
    expect((h.page.setViewport.mock.calls.at(-1) as any)[0].height).toBeGreaterThanOrEqual(2400);
  });

  it("fails the export when the capture fails, instead of shipping the file without its charts", async () => {
    h.page.goto.mockRejectedValueOnce(new Error("Navigation timeout of 60000 ms exceeded"));
    await expect(renderXlsx(report([kpiBlock, chartBlock]), {}, OPTS)).rejects.toThrow("Navigation timeout");
    expect(h.context.close).toHaveBeenCalledTimes(1);
  });

  it("fails the export when the report never rendered", async () => {
    h.page.waitForSelector.mockRejectedValueOnce(new Error("timeout"));
    await expect(renderXlsx(report([chartBlock]), {}, OPTS)).rejects.toThrow(/XLSX export: report r1 did not render/);
    expect(h.el.screenshot).not.toHaveBeenCalled();
  });

  it("fails the export when the charts never finish drawing, instead of screenshotting empty cards", async () => {
    h.page.waitForFunction.mockRejectedValueOnce(new Error("timeout"));
    await expect(renderXlsx(report([chartBlock]), {}, OPTS)).rejects.toThrow(/charts never finished drawing/);
    expect(h.el.screenshot).not.toHaveBeenCalled();
  });

  it("fails the export when a chart is missing from the rendered report", async () => {
    h.page.$.mockResolvedValueOnce(null);
    await expect(renderXlsx(report([chartBlock]), {}, OPTS)).rejects.toThrow(/couldn't capture chart block c1/);
  });

  it("never opens a browser for a report with nothing to screenshot", async () => {
    const buf = await renderXlsx(report([kpiBlock]), {}, OPTS);
    expect(buf.length).toBeGreaterThan(0);
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.browser.createBrowserContext).not.toHaveBeenCalled();
  });

  it("doesn't look for a chart hidden from the caller, which the viewer page never draws for them", async () => {
    // The viewer page drops the gated chart for this caller, so it isn't there to find.
    h.page.$.mockResolvedValue(null);
    const gated = { ...chartBlock, visibleToRoles: ["finance"] };
    const buf = await renderXlsx(report([kpiBlock, gated]), {}, { ...OPTS, viewer: { id: "u1", isAdmin: false, roles: [] } });
    expect(buf.length).toBeGreaterThan(0);
    expect(h.browser.createBrowserContext).not.toHaveBeenCalled();
  });

  it("still captures that chart for a caller with the role", async () => {
    const gated = { ...chartBlock, visibleToRoles: ["finance"] };
    await renderXlsx(report([kpiBlock, gated]), {}, { ...OPTS, viewer: { id: "u1", isAdmin: false, roles: ["finance"] } });
    expect(h.page.$).toHaveBeenCalledWith('[data-block-id="c1"]');
  });

  it("asks the capture page for the caller's blocks, so a gated chart an admin API key keeps is there to capture", async () => {
    // The page filtered blocks as nobody on every token render, so an admin
    // key's XLSX waited for a chart the page never drew and failed with 500.
    const admin = { id: "apikey:k1", isAdmin: true, roles: [] };
    const gated = { ...chartBlock, visibleToRoles: ["nobody-holds-this"] };
    await renderXlsx(report([kpiBlock, gated]), {}, { ...OPTS, viewer: admin });
    expect(mintRenderToken).toHaveBeenCalledWith(expect.objectContaining({ viewer: admin, blocksAsViewer: true }));
    expect(h.page.$).toHaveBeenCalledWith('[data-block-id="c1"]');
  });
});
