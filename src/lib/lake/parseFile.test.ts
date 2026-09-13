/**
 * parseUpload() was extracted from app/api/lake/tables/route.ts (previously
 * inline, unshared, untested — see that route's comment) so the SFTP pull
 * could reuse it. These pin its three format paths since it now has two
 * real callers instead of zero test coverage.
 */
import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { parseUpload, parseUploadWithMeta } from "./parseFile";

describe("parseUpload", () => {
  it("parses CSV with a header row", async () => {
    const buf = Buffer.from("name,amount\nAcme,100\nWidgets Inc,250\n");
    const rows = await parseUpload(buf, "orders.csv");
    expect(rows).toEqual([
      { name: "Acme", amount: "100" },
      { name: "Widgets Inc", amount: "250" },
    ]);
  });

  it("parses TSV using the .tsv extension to pick the delimiter", async () => {
    const buf = Buffer.from("name\tamount\nAcme\t100\n");
    const rows = await parseUpload(buf, "orders.tsv");
    expect(rows).toEqual([{ name: "Acme", amount: "100" }]);
  });

  it("parses a JSON array", async () => {
    const buf = Buffer.from(JSON.stringify([{ a: 1 }, { a: 2 }]));
    const rows = await parseUpload(buf, "data.json");
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("parses a JSON object by finding its first array-valued field", async () => {
    const buf = Buffer.from(JSON.stringify({ meta: "x", items: [{ a: 1 }] }));
    const rows = await parseUpload(buf, "data.json");
    expect(rows).toEqual([{ a: 1 }]);
  });

  it("rejects a JSON object with no array field", async () => {
    const buf = Buffer.from(JSON.stringify({ meta: "x" }));
    await expect(parseUpload(buf, "data.json")).rejects.toThrow(/must be an array/);
  });

  it("parses XLSX with a header row on sheet 1", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(["name", "amount"]);
    ws.addRow(["Acme", 100]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const rows = await parseUpload(buf, "orders.xlsx");
    expect(rows).toEqual([{ name: "Acme", amount: 100 }]);
  });

  it("gives a blank CSV header a positional name instead of a nameless column", async () => {
    // A trailing comma or a spacer column produces a "" header, and every
    // such column then lands under the same empty key.
    const buf = Buffer.from("region,,amount\nNorth,spacer,100\n");
    const rows = await parseUpload(buf, "orders.csv");
    expect(Object.keys(rows[0])).toEqual(["region", "column_2", "amount"]);
    expect(rows[0].column_2).toBe("spacer");
  });

  it("leaves ordinary headers alone", async () => {
    const buf = Buffer.from("region,amount\nNorth,100\n");
    const rows = await parseUpload(buf, "orders.csv");
    expect(Object.keys(rows[0])).toEqual(["region", "amount"]);
  });

  it("rejects a malformed CSV row count mismatch as a parse error", async () => {
    // A quoted field with an unterminated quote is Papa's canonical parse-error case.
    const buf = Buffer.from('name,amount\n"Acme,100\n');
    await expect(parseUpload(buf, "orders.csv")).rejects.toThrow(/CSV parse error/);
  });
});

/**
 * Multi-sheet workbooks. Reading only worksheets[0] threw every other sheet
 * away with nothing said about it — a budget workbook with a tab per quarter
 * imported as Q1 and looked complete.
 */
describe("parseUploadWithMeta — workbook sheets", () => {
  async function threeSheetWorkbook(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const q1 = wb.addWorksheet("Q1");
    q1.addRow(["region", "amount"]);
    q1.addRow(["North", 100]);
    const q2 = wb.addWorksheet("Q2");
    q2.addRow(["region", "amount"]);
    q2.addRow(["South", 200]);
    q2.addRow(["East", 300]);
    const notes = wb.addWorksheet("Notes");
    notes.addRow(["comment"]);
    notes.addRow(["draft"]);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it("reports every sheet in the workbook, not just the one it read", async () => {
    const out = await parseUploadWithMeta(await threeSheetWorkbook(), "budget.xlsx");
    expect(out.sheets).toEqual(["Q1", "Q2", "Notes"]);
  });

  it("defaults to the first sheet and says which one that was", async () => {
    const out = await parseUploadWithMeta(await threeSheetWorkbook(), "budget.xlsx");
    expect(out.sheet).toBe("Q1");
    expect(out.rows).toEqual([{ region: "North", amount: 100 }]);
  });

  it("reads a named sheet — the rows the old code silently dropped", async () => {
    const out = await parseUploadWithMeta(await threeSheetWorkbook(), "budget.xlsx", { sheet: "Q2" });
    expect(out.sheet).toBe("Q2");
    expect(out.rows).toEqual([
      { region: "South", amount: 200 },
      { region: "East", amount: 300 },
    ]);
  });

  it("throws on an unknown sheet instead of quietly importing sheet 1", async () => {
    // Falling back would land Q1's rows under a table the user named Q3.
    await expect(
      parseUploadWithMeta(await threeSheetWorkbook(), "budget.xlsx", { sheet: "Q3" }),
    ).rejects.toThrow(/Sheet "Q3" not found.*Q1, Q2, Notes/);
  });

  it("names the offending sheet when it has no header row", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Data").addRow(["id"]);
    wb.addWorksheet("Empty");
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await expect(parseUploadWithMeta(buf, "b.xlsx", { sheet: "Empty" })).rejects.toThrow(/Sheet "Empty" has no header row/);
  });

  it("leaves CSV and JSON with no sheet metadata to choose from", async () => {
    const csv = await parseUploadWithMeta(Buffer.from("a,b\n1,2\n"), "x.csv");
    expect(csv.sheets).toEqual([]);
    expect(csv.sheet).toBeNull();
    const json = await parseUploadWithMeta(Buffer.from('[{"a":1}]'), "x.json");
    expect(json.sheets).toEqual([]);
    expect(json.sheet).toBeNull();
  });
});
