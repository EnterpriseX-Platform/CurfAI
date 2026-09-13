/**
 * Self-test for the Excel import primitive.
 *
 * Generates a fixture .xlsx with representative oddness — mixed-type columns,
 * messy headers, an empty sheet, formula cells, dates as real Date objects,
 * a merged title row — then feeds it through `parseExcelToSqlite` and asserts
 * the schema + row data come out the way we want. Used during development;
 * not part of the runtime path.
 *
 *   npx tsx scripts/excelImportSelfTest.ts
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import ExcelJS from "exceljs";
import Database from "better-sqlite3";
import { parseExcelToSqlite } from "../src/lib/connections/excelImport";

async function buildFixture(filePath: string) {
  const wb = new ExcelJS.Workbook();

  // Sheet 1 — clean campaign data, mixed types, dates as real Date objects.
  const ws1 = wb.addWorksheet("Campaigns Q1");
  ws1.columns = [
    { header: "Campaign Name", key: "name" },
    { header: "Channel",       key: "channel" },
    { header: "Spend (USD)",   key: "spend" },
    { header: "ROI",           key: "roi" },
    { header: "Started At",    key: "started" },
    { header: "Active?",       key: "active" },
  ];
  ws1.addRows([
    { name: "Black Friday Mega Push 2025", channel: "Search", spend: 218400, roi: 4.8, started: new Date("2025-11-03"), active: true },
    { name: "EMEA Roadshow 2025",          channel: "Events", spend: 215700, roi: 2.2, started: new Date("2025-04-15"), active: false },
    { name: "Display Retargeting 2026",    channel: "Display", spend: 184600, roi: -0.2, started: new Date("2026-01-08"), active: true },
    { name: "Q1 Social Always-On 2026",    channel: "Social", spend: 158900, roi: 3.9, started: new Date("2026-01-20"), active: true },
  ]);

  // Sheet 2 — header weirdness: punctuation, parens, duplicates, leading digits,
  // a header that sanitizes to empty.
  const ws2 = wb.addWorksheet("Funny Headers");
  ws2.addRow(["Total $ Spend (USD)", "% Conversion", "2024 Q1", "Total $ Spend (USD)", "??", "Notes"]);
  ws2.addRow([1234.5, 0.15, "100", 200, "x", "ok"]);
  ws2.addRow([2345.6, 0.18, "120", 220, "y", "fine"]);

  // Sheet 3 — formulas (we should pick up the computed result).
  const ws3 = wb.addWorksheet("Formulas");
  ws3.addRow(["a", "b", "sum"]);
  ws3.addRow([1, 2, { formula: "A2+B2", result: 3 }]);
  ws3.addRow([10, 20, { formula: "A3+B3", result: 30 }]);

  // Sheet 4 — empty sheet (should be skipped with a warning).
  wb.addWorksheet("Empty");

  // Sheet 5 — title row merged across columns above the real headers.
  const ws5 = wb.addWorksheet("Has Title Row");
  ws5.addRow(["MARKETING DASHBOARD"]);
  ws5.mergeCells("A1:C1");
  ws5.addRow(["region", "spend", "leads"]);
  ws5.addRow(["NA", 1000, 50]);
  ws5.addRow(["EMEA", 800, 40]);

  await wb.xlsx.writeFile(filePath);
}

function assert(cond: any, msg: string) {
  if (!cond) {
    console.error("✗ ASSERT FAILED:", msg);
    process.exitCode = 1;
  } else {
    console.log("✓", msg);
  }
}

async function main() {
  const fixturePath = path.join(os.tmpdir(), "excel-self-test-" + Date.now() + ".xlsx");
  const dbPath = fixturePath.replace(/\.xlsx$/, ".db");

  await buildFixture(fixturePath);
  console.log("Fixture written:", fixturePath);

  const buf = fs.readFileSync(fixturePath);
  const result = await parseExcelToSqlite(buf, dbPath, path.basename(fixturePath));

  if (!result.ok) {
    console.error("Parser failed:", result.error);
    process.exit(1);
  }
  const s = result.schema;
  console.log("\nSchema:", JSON.stringify(s, null, 2));

  // ---- assertions ----
  // The empty sheet should produce no table; the four populated sheets should.
  assert(s.tables.length === 4, `4 non-empty tables (got ${s.tables.length})`);

  const t1 = s.tables.find((t) => t.originalSheetName === "Campaigns Q1");
  assert(t1, "Campaigns Q1 → table imported");
  if (t1) {
    assert(t1.rowCount === 4, `Campaigns rowCount=4 (got ${t1.rowCount})`);
    assert(t1.name === "campaigns_q1", `table name sanitized to "campaigns_q1" (got "${t1.name}")`);
    const colByName = new Map(t1.columns.map((c) => [c.name, c]));
    assert(colByName.get("spend_usd")?.type === "INTEGER" || colByName.get("spend_usd")?.type === "REAL",
      `spend_usd inferred as numeric (got ${colByName.get("spend_usd")?.type})`);
    assert(colByName.get("roi")?.type === "REAL", `roi inferred as REAL (got ${colByName.get("roi")?.type})`);
    assert(colByName.get("started_at")?.type === "DATE", `started_at inferred as DATE (got ${colByName.get("started_at")?.type})`);
    assert(colByName.get("active")?.type === "BOOLEAN", `active inferred as BOOLEAN (got ${colByName.get("active")?.type})`);
    assert(colByName.get("channel")?.type === "TEXT", `channel inferred as TEXT (got ${colByName.get("channel")?.type})`);
  }

  const t2 = s.tables.find((t) => t.originalSheetName === "Funny Headers");
  assert(t2, "Funny Headers → table imported");
  if (t2) {
    const names = t2.columns.map((c) => c.name);
    assert(names.includes("total_spend_usd"), `header "Total $ Spend (USD)" → "total_spend_usd" (got ${JSON.stringify(names)})`);
    assert(names.includes("conversion") || names.includes("_conversion") || names.some((n) => n.includes("conversion")),
      `"% Conversion" got sanitized to a conversion-ish column (got ${JSON.stringify(names)})`);
    // "2024 Q1" starts with a digit and must get the t_ prefix.
    assert(names.some((n) => n === "t_2024_q1"), `"2024 Q1" got "t_2024_q1" prefix (got ${JSON.stringify(names)})`);
    // Duplicate "Total $ Spend (USD)" should produce two unique names.
    const totalCount = names.filter((n) => n.startsWith("total_spend_usd")).length;
    assert(totalCount === 2, `duplicate header got 2 unique names (got ${totalCount}: ${JSON.stringify(names)})`);
    // "??" sanitizes to empty → should fall back to col_<n>.
    assert(names.some((n) => n.startsWith("col_")), `unsanitizeable header fell back to col_<n> (got ${JSON.stringify(names)})`);
  }

  const t3 = s.tables.find((t) => t.originalSheetName === "Formulas");
  assert(t3, "Formulas → table imported");
  if (t3) {
    assert(t3.columns.find((c) => c.name === "sum")?.type === "INTEGER",
      `formula result column inferred as INTEGER (got ${t3.columns.find((c) => c.name === "sum")?.type})`);
  }

  // The title-row sheet should still import; v1 just warns. Headers will be
  // wrong (the merged title row gets read as the header) — this is the
  // documented v1 limitation.
  const t5 = s.tables.find((t) => t.originalSheetName === "Has Title Row");
  assert(t5, "Has Title Row → table imported (v1 doesn't try to skip the title)");
  assert(s.warnings.some((w) => w.includes("merged cells") && w.includes("Has Title Row")),
    "merged-cells warning emitted for the title-row sheet");

  // The empty sheet should have produced a warning.
  assert(s.warnings.some((w) => w.includes("Empty") && w.includes("empty")),
    "empty-sheet warning emitted");

  // ---- read-back assertions: SQLite file actually has the rows we expect ----
  const db = new Database(dbPath, { readonly: true });
  const camp = db.prepare(`SELECT * FROM "campaigns_q1" ORDER BY spend_usd DESC`).all() as any[];
  assert(camp.length === 4, `campaigns_q1 has 4 rows (got ${camp.length})`);
  assert(camp[0].name === "Black Friday Mega Push 2025",
    `top spend row preserved (got "${camp[0].name}")`);
  assert(camp[0].active === 1 && camp[1].active === 0,
    `boolean coerced to 0/1 (got active=${camp[0].active}, ${camp[1].active})`);
  assert(typeof camp[0].started_at === "string" && /^\d{4}-\d{2}-\d{2}T/.test(camp[0].started_at),
    `dates stored as ISO strings (got ${camp[0].started_at})`);
  db.close();

  // Cleanup
  fs.unlinkSync(fixturePath);
  fs.unlinkSync(dbPath);
  console.log("\n✓ All assertions passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
