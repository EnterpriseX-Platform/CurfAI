/**
 * A scheduled or downloaded xlsx / docx / csv of a report whose query FAILED used to
 * go out with a blank KPI / an empty table — the runner reports a failure as an empty
 * array — in a file that then travels with no sign that anything is missing. (The PDF
 * and the viewer now show it in-page.) xlsx and docx carry a visible note where the
 * block would be; a csv can't carry a note, so it fails with the reason.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";

const h = vi.hoisted(() => ({ provenance: {} as Record<string, any>, dataset: {} as Record<string, any[]> }));

vi.mock("puppeteer", () => ({ default: {} }));
vi.mock("@/lib/reporting/runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reporting/runner")>();
  return {
    ...actual,
    runReportWithProof: vi.fn(async () => ({ dataset: h.dataset, provenance: h.provenance })),
  };
});

import { renderXlsx } from "./xlsx";
import { renderDocx } from "./docx";
import { renderCsv } from "./csv";

const REASON = "no such table: table_that_does_not_exist";
const REPORT: any = {
  version: 1, name: "Revenue", parameters: [],
  dataSources: [
    { id: "ok_q", name: "Healthy", dataSourceId: "ds1", sql: "SELECT 42 AS v" },
    { id: "ok_t", name: "Healthy table", dataSourceId: "ds1", sql: "SELECT 'a' AS name" },
    { id: "bad_q", name: "Broken", dataSourceId: "ds1", sql: "SELECT nope FROM t" },
  ],
  pages: [{
    id: "p1", size: "A4", orientation: "portrait",
    blocks: [
      { id: "k1", type: "kpi", x: 0, y: 0, w: 6, h: 3, config: { queryId: "ok_q", label: "Healthy KPI", valueField: "v", format: "number" } },
      { id: "k2", type: "kpi", x: 6, y: 0, w: 6, h: 3, config: { queryId: "bad_q", label: "Broken KPI", valueField: "v", format: "number" } },
      { id: "t1", type: "table", x: 0, y: 3, w: 12, h: 4, config: { queryId: "bad_q", title: "Broken table", columns: [{ key: "n", label: "N", type: "text", align: "left", total: "none" }] } },
    ],
  }],
};

beforeEach(() => {
  h.dataset = { ok_q: [{ v: 42 }], ok_t: [{ name: "a" }], bad_q: [] };
  h.provenance = { ok_q: {}, ok_t: {}, bad_q: { executionError: REASON } };
});

const cellText = (v: any): string =>
  v == null ? "" : typeof v === "object" && Array.isArray(v.richText) ? v.richText.map((t: any) => t.text).join("") : String(v);
async function sheetTexts(buf: Buffer, sheetName?: string): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const out: string[] = [];
  for (const ws of wb.worksheets) {
    if (sheetName && !ws.name.startsWith(sheetName)) continue;
    ws.eachRow((row) => row.eachCell((c) => { const t = cellText(c.value); if (t) out.push(t); }));
  }
  return out;
}

describe("renderXlsx — a failed query is visible in the file", () => {
  it("puts a note where the failed KPI would be, and leaves the healthy one alone", async () => {
    const texts = await sheetTexts(await renderXlsx(REPORT, {}, { tenantId: "t1" }), "Report");
    expect(texts.some((t) => t.includes("This query didn't run: " + REASON) && t.includes("Broken KPI"))).toBe(true);
    expect(texts).toContain("Healthy KPI");
    expect(texts.some((t) => /^42$/.test(t))).toBe(true);
  });

  it("the raw-data sheet of a failed table says why it is empty, instead of a bare header row", async () => {
    const texts = await sheetTexts(await renderXlsx(REPORT, {}, { tenantId: "t1" }), "Data 1");
    expect(texts).toEqual([expect.stringContaining("This query didn't run, so there is no data here: " + REASON)]);
  });

  it("is unchanged when every query ran", async () => {
    h.provenance = { ok_q: {}, ok_t: {}, bad_q: {} };
    const texts = await sheetTexts(await renderXlsx(REPORT, {}, { tenantId: "t1" }));
    expect(texts.join("\n")).not.toContain("didn't run");
  });
});

describe("renderDocx — a failed query is visible in the document", () => {
  const documentXml = async (buf: Buffer) => (await (await JSZip.loadAsync(buf)).file("word/document.xml")!.async("string")).replace(/&apos;/g, "'");

  it("writes the note in place of the failed KPI, and the healthy KPI's value", async () => {
    const xml = await documentXml(await renderDocx(REPORT, {}, { tenantId: "t1" }));
    expect(xml).toContain("This query didn't run: " + REASON);
    expect(xml).toContain("Broken KPI");
    expect(xml).toContain("Healthy KPI");
  });

  it("does not render the failed table as an empty table", async () => {
    const xml = await documentXml(await renderDocx(REPORT, {}, { tenantId: "t1" }));
    expect(xml).not.toContain("<w:tbl>");
  });

  it("is unchanged when every query ran", async () => {
    h.provenance = { ok_q: {}, ok_t: {}, bad_q: {} };
    expect(await documentXml(await renderDocx(REPORT, {}, { tenantId: "t1" }))).not.toContain("didn't run");
  });
});

describe("renderCsv — a table that didn't load has nothing honest to write", () => {
  it("fails with the reason instead of writing a header-only file", async () => {
    await expect(renderCsv(REPORT, {}, { tenantId: "t1", blockId: "t1" })).rejects.toThrow("This table's data didn't load, so there is nothing to export: " + REASON);
  });

  it("still exports a table whose query ran", async () => {
    const report = { ...REPORT, pages: [{ ...REPORT.pages[0], blocks: [{ id: "t2", type: "table", x: 0, y: 0, w: 12, h: 4, config: { queryId: "ok_t", title: "T", columns: [{ key: "name", label: "Name", type: "text", align: "left", total: "none" }] } }] }] };
    expect(await renderCsv(report, {}, { tenantId: "t1" })).toBe("Name\r\na");
  });

  it("a table that genuinely returned no rows still exports (an empty file, as before), and does not throw", async () => {
    h.provenance = { ok_q: {}, ok_t: {}, bad_q: {} }; // ran, just empty
    await expect(renderCsv(REPORT, {}, { tenantId: "t1", blockId: "t1" })).resolves.toBe("");
  });
});
