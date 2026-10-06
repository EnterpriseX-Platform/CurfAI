import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { columnIndex, excelSerialToIso, isDateFormatCode, openXlsx } from "./xlsxStream";

async function workbook(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function allRows(buf: Buffer, sheet?: string) {
  const wb = await openXlsx({ buffer: buf });
  const rows: Array<Record<string, unknown>> = [];
  for await (const r of wb.rows(sheet)) rows.push(r);
  return rows;
}

describe("openXlsx rows", () => {
  it("reads strings, numbers, booleans and formula results under the header", async () => {
    const buf = await workbook((wb) => {
      const ws = wb.addWorksheet("Data");
      ws.addRow(["store", "qty", "active", "total"]);
      ws.addRow(["บางนา", 3, true, { formula: "B2*2", result: 6 }]);
      ws.addRow(["Acme, Inc.", 1.5, false, { formula: "B3*2", result: 3 }]);
    });
    expect(await allRows(buf)).toEqual([
      { store: "บางนา", qty: 3, active: true, total: 6 },
      { store: "Acme, Inc.", qty: 1.5, active: false, total: 3 },
    ]);
  });

  it("turns date-formatted cells into ISO strings, like the exceljs path did", async () => {
    const buf = await workbook((wb) => {
      const ws = wb.addWorksheet("Data");
      ws.addRow(["day", "amount"]);
      ws.addRow([new Date(Date.UTC(2026, 8, 21)), 100]);
    });
    expect(await allRows(buf)).toEqual([{ day: "2026-09-21T00:00:00.000Z", amount: 100 }]);
  });

  it("names blank header cells positionally and keeps empty cells as null", async () => {
    const buf = await workbook((wb) => {
      const ws = wb.addWorksheet("Data");
      ws.getCell("A1").value = "region";
      ws.getCell("C1").value = "amount";
      ws.getCell("A2").value = "North";
      ws.getCell("C2").value = 5;
      ws.getCell("A3").value = "South";
      ws.getCell("B3").value = "note";
    });
    expect(await allRows(buf)).toEqual([
      { region: "North", col_2: null, amount: 5 },
      { region: "South", col_2: "note", amount: null },
    ]);
  });

  it("skips blank rows, including ones above the header", async () => {
    const buf = await workbook((wb) => {
      const ws = wb.addWorksheet("Data");
      ws.getCell("A3").value = "name";
      ws.getCell("A4").value = "x";
      ws.getCell("A6").value = "y";
    });
    expect(await allRows(buf)).toEqual([{ name: "x" }, { name: "y" }]);
  });

  it("reads the sheet it is asked for, and refuses one that isn't there", async () => {
    const buf = await workbook((wb) => {
      wb.addWorksheet("Q1").addRows([["v"], [1]]);
      wb.addWorksheet("Q2").addRows([["v"], [2]]);
    });
    const wb = await openXlsx({ buffer: buf });
    expect(wb.sheets).toEqual(["Q1", "Q2"]);
    expect(await allRows(buf, "Q2")).toEqual([{ v: 2 }]);
    expect(() => wb.resolveSheet("Q3")).toThrow(/Sheet "Q3" not found\. This workbook has: Q1, Q2/);
  });

  it("stops cleanly when the reader only wants the first rows", async () => {
    const buf = await workbook((wb) => {
      const ws = wb.addWorksheet("Data");
      ws.addRow(["n"]);
      for (let i = 0; i < 5000; i++) ws.addRow([i]);
    });
    const wb = await openXlsx({ buffer: buf });
    const first: unknown[] = [];
    for await (const r of wb.rows()) { first.push(r.n); if (first.length === 3) break; }
    expect(first).toEqual([0, 1, 2]);
    expect(await wb.declaredRowCount()).toBe(5001);
  });

  it("uses the 1904 date system when the workbook says so", async () => {
    const buf = await workbook((wb) => {
      wb.properties.date1904 = true;
      const ws = wb.addWorksheet("Data");
      ws.addRow(["day"]);
      ws.addRow([new Date(Date.UTC(2026, 0, 2))]);
    });
    expect(await allRows(buf)).toEqual([{ day: "2026-01-02T00:00:00.000Z" }]);
  });

  it("fails with a plain message on a file that isn't a workbook", async () => {
    await expect(openXlsx({ buffer: Buffer.from("name,amount\n") })).rejects.toThrow(/isn't a valid \.xlsx workbook/);
  });
});

describe("helpers", () => {
  it("columnIndex", () => {
    expect(columnIndex("A1")).toBe(0);
    expect(columnIndex("Z9")).toBe(25);
    expect(columnIndex("AA10")).toBe(26);
    expect(columnIndex("U1048576")).toBe(20);
    expect(columnIndex("12")).toBe(-1);
  });

  it("isDateFormatCode", () => {
    expect(isDateFormatCode("yyyy-mm-dd")).toBe(true);
    expect(isDateFormatCode("[$-th-TH]d/m/bbbb")).toBe(true);
    expect(isDateFormatCode("[h]:mm:ss")).toBe(true);
    expect(isDateFormatCode("#,##0.00")).toBe(false);
    expect(isDateFormatCode('#,##0 "days"')).toBe(false);
    expect(isDateFormatCode("General")).toBe(false);
    expect(isDateFormatCode("0.00E+00")).toBe(false);
  });

  it("excelSerialToIso", () => {
    expect(excelSerialToIso(46286, false)).toBe("2026-09-21T00:00:00.000Z");
    expect(excelSerialToIso(46286.5, false)).toBe("2026-09-21T12:00:00.000Z");
  });
});
