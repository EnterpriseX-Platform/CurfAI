/**
 * A block's visibleToRoles hid it in the viewer and the story page, but the
 * xlsx / docx / csv renderers walked the full definition. So a viewer
 * without the role could download the block from /api/reports/:id/export/*
 * or schedule "Run now". The renderers now keep only the blocks this viewer
 * may see, and with no viewer (the cron tick) they drop gated blocks the
 * way the viewer page does for a render token with no session.
 */
import { describe, it, expect, vi } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";

vi.mock("puppeteer", () => ({ default: {} }));
vi.mock("@/lib/reporting/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reporting/runner")>()),
  runReportWithProof: vi.fn(async () => ({
    dataset: {
      q_open: [{ v: 7 }],
      q_fin: [{ v: 99 }],
      q_salaries: [{ name: "Alice", salary: 123456 }],
      q_headcount: [{ team: "Ops", people: 12 }],
    },
    provenance: {},
  })),
}));

import { renderXlsx } from "./xlsx";
import { renderDocx } from "./docx";
import { renderCsv } from "./csv";
import type { RunViewer } from "@/lib/reporting/runner";

const FINANCE = ["finance"];
const col = (key: string, label: string, type = "string") => ({ key, label, type, align: "left", total: "none" });
const REPORT: any = {
  version: 1, name: "People", parameters: [],
  dataSources: ["q_open", "q_fin", "q_salaries", "q_headcount"].map((id) => ({ id, name: id, dataSourceId: "ds1", sql: "SELECT 1" })),
  pages: [{
    id: "p1", size: "A4", orientation: "portrait",
    blocks: [
      { id: "k_open", type: "kpi", x: 0, y: 0, w: 6, h: 3, config: { queryId: "q_open", label: "Open KPI", valueField: "v", format: "number" } },
      { id: "k_fin", type: "kpi", x: 6, y: 0, w: 6, h: 3, visibleToRoles: FINANCE, config: { queryId: "q_fin", label: "Finance KPI", valueField: "v", format: "number" } },
      // Gated and first, so "the first table" must skip it for a caller without the role.
      { id: "t_fin", type: "table", x: 0, y: 3, w: 12, h: 4, visibleToRoles: FINANCE, config: { queryId: "q_salaries", title: "Salaries", columns: [col("name", "Name"), col("salary", "Salary", "number")] } },
      { id: "t_open", type: "table", x: 0, y: 7, w: 12, h: 4, config: { queryId: "q_headcount", title: "Headcount", columns: [col("team", "Team"), col("people", "People", "number")] } },
    ],
  }],
};

const viewer = (roles: string[] = []): RunViewer => ({ id: "u-viewer", isAdmin: false, roles });
const admin: RunViewer = { id: "u-admin", isAdmin: true, roles: [] };

async function xlsxText(buf: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const out: string[] = [];
  for (const ws of wb.worksheets) {
    out.push(`[sheet ${ws.name}]`);
    ws.eachRow((row) => row.eachCell((c) => out.push(String(c.value ?? ""))));
  }
  return out.join("\n");
}
async function docxText(buf: Buffer): Promise<string> {
  return (await JSZip.loadAsync(buf)).file("word/document.xml")!.async("string");
}

describe("block visibility in file exports", () => {
  describe("a viewer without the role", () => {
    it("csv: the first table is the first one they can see", async () => {
      const csv = await renderCsv(REPORT, {}, { tenantId: "t1", viewer: viewer() });
      expect(csv).toContain("Ops");
      expect(csv).not.toContain("Alice");
    });

    it("csv: ?block= can't name a hidden table", async () => {
      await expect(renderCsv(REPORT, {}, { tenantId: "t1", blockId: "t_fin", viewer: viewer() })).rejects.toThrow("No table block to export as CSV");
    });

    it("xlsx: no hidden KPI on the Report sheet and no Data sheet for the hidden table", async () => {
      const text = await xlsxText(await renderXlsx(REPORT, {}, { tenantId: "t1", viewer: viewer() }));
      expect(text).toContain("Open KPI");
      expect(text).toContain("[sheet Data 1 - Headcount]");
      expect(text).not.toContain("Finance KPI");
      expect(text).not.toContain("Salaries");
      expect(text).not.toContain("Alice");
    });

    it("docx: neither hidden block is in the document", async () => {
      const xml = await docxText(await renderDocx(REPORT, {}, { tenantId: "t1", viewer: viewer() }));
      expect(xml).toContain("Open KPI");
      expect(xml).toContain("Headcount");
      expect(xml).not.toContain("Finance KPI");
      expect(xml).not.toContain("Alice");
    });

    it("an unrelated role doesn't unlock them", async () => {
      await expect(renderCsv(REPORT, {}, { tenantId: "t1", blockId: "t_fin", viewer: viewer(["marketing"]) })).rejects.toThrow("No table block");
    });
  });

  describe("a viewer with the role, and an admin", () => {
    for (const [who, v] of [["finance viewer", viewer(FINANCE)], ["admin", admin]] as const) {
      it(`${who}: gets every block in all three formats`, async () => {
        expect(await renderCsv(REPORT, {}, { tenantId: "t1", blockId: "t_fin", viewer: v })).toContain("Alice");
        const text = await xlsxText(await renderXlsx(REPORT, {}, { tenantId: "t1", viewer: v }));
        expect(text).toContain("Finance KPI");
        expect(text).toContain("[sheet Data 1 - Salaries]");
        const xml = await docxText(await renderDocx(REPORT, {}, { tenantId: "t1", viewer: v }));
        expect(xml).toContain("Finance KPI");
        expect(xml).toContain("Alice");
      });
    }
  });

  describe("no viewer (the cron tick)", () => {
    it("drops gated blocks, as the scheduled PDF does", async () => {
      await expect(renderCsv(REPORT, {}, { tenantId: "t1", blockId: "t_fin" })).rejects.toThrow("No table block");
      expect(await xlsxText(await renderXlsx(REPORT, {}, { tenantId: "t1" }))).not.toContain("Finance KPI");
      expect(await docxText(await renderDocx(REPORT, {}, { tenantId: "t1" }))).not.toContain("Alice");
    });
  });

  it("leaves the caller's report object untouched", async () => {
    await renderCsv(REPORT, {}, { tenantId: "t1", viewer: viewer() });
    expect(REPORT.pages[0].blocks.map((b: any) => b.id)).toEqual(["k_open", "k_fin", "t_fin", "t_open"]);
  });
});
