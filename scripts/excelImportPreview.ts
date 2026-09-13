/**
 * CLI preview for the Excel import primitive.
 *
 * Usage:
 *   npx tsx scripts/excelImportPreview.ts <path-to-xlsx> [output.db]
 *
 * Runs the same `parseExcelToSqlite` the upload API will call, prints the
 * schema metadata + warnings, and runs a `SELECT *` sample against each
 * table so you can see what shape the report runner will see. Used during
 * development to validate the parser against real customer-shaped files
 * without spinning up the full server.
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import Database from "better-sqlite3";
import { parseExcelToSqlite } from "../src/lib/connections/excelImport";

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("usage: tsx scripts/excelImportPreview.ts <path-to-xlsx> [output.db]");
    process.exit(2);
  }
  if (!fs.existsSync(inputPath)) {
    console.error("File not found:", inputPath);
    process.exit(1);
  }
  const dbPath = process.argv[3] ?? path.join(os.tmpdir(), "excel-preview-" + Date.now() + ".db");

  const buf = fs.readFileSync(inputPath);
  const filename = path.basename(inputPath);
  const startedAt = Date.now();
  const result = await parseExcelToSqlite(buf, dbPath, filename);
  const elapsed = Date.now() - startedAt;

  if (!result.ok) {
    console.error("FAILED:", result.error);
    process.exit(1);
  }

  const s = result.schema;
  console.log("=".repeat(60));
  console.log("Excel import preview");
  console.log("=".repeat(60));
  console.log("Source:    " + s.originalFilename);
  console.log("Size:      " + formatBytes(s.fileSize));
  console.log("Output:    " + dbPath);
  console.log("Elapsed:   " + elapsed + " ms");
  console.log("Tables:    " + s.tables.length);
  console.log();
  for (const t of s.tables) {
    console.log("─".repeat(60));
    console.log(`Table "${t.name}"  (sheet "${t.originalSheetName}", ${t.rowCount.toLocaleString()} rows)`);
    console.log("─".repeat(60));
    for (const c of t.columns) {
      const sampleStr = c.sample == null ? "(null)" : truncate(JSON.stringify(c.sample), 50);
      console.log(`  ${pad(c.name, 30)} ${pad(c.type, 8)} ${pad("[" + truncate(c.originalHeader, 24) + "]", 28)}  e.g. ${sampleStr}`);
    }
  }
  if (s.warnings.length) {
    console.log();
    console.log("⚠ Warnings:");
    for (const w of s.warnings) console.log("  • " + w);
  }
  // Quick sanity probe — read back the first 3 rows of each table from
  // the SQLite file so we can confirm bulk insert worked.
  console.log();
  console.log("=".repeat(60));
  console.log("Sample rows (first 3 per table)");
  console.log("=".repeat(60));
  const db = new Database(dbPath, { readonly: true });
  for (const t of s.tables) {
    console.log(`\n[${t.name}]`);
    const rows = db.prepare(`SELECT * FROM "${t.name}" LIMIT 3`).all();
    if (rows.length === 0) { console.log("  (no rows)"); continue; }
    console.table(rows);
  }
  db.close();
}

function pad(s: string, n: number) { return s.length >= n ? s : s + " ".repeat(n - s.length); }
function truncate(s: string, n: number) { return s.length <= n ? s : s.slice(0, n - 1) + "…"; }
function formatBytes(n: number) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
