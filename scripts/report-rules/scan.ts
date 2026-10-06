/**
 * Read-only check of reports already saved, against the rules code can check
 * on its own (src/lib/intelligence/reportRules.ts → detectViolations), using
 * each report's real rows. For finding which saved reports need attention —
 * e.g. the ones Master Builder built before its reports passed the gate.
 *
 * Writes nothing: Postgres is only SELECTed from, and each workspace's lake
 * file is opened read-only with query_only on. Prints report and block
 * titles, rule ids and counts — never row values.
 *
 * Runs inside the app's pod, where the lake files and DATABASE_URL are:
 *   node node_modules/esbuild/bin/esbuild scripts/report-rules/scan.ts --bundle --platform=node \
 *     --format=cjs --external:pg --external:better-sqlite3 --outfile=scan.cjs
 *   kubectl -n curfai exec -i <pod> -c curfai -- node - < scan.cjs
 * SCAN_SCOPE=all checks every report instead of Master Builder's.
 */
import { Client } from "pg";
import Database from "better-sqlite3";
import { existsSync } from "fs";
import { join } from "path";
import { authorshipOf, detectViolations, type Violation } from "../../src/lib/intelligence/reportRules";
import type { Report } from "../../src/lib/reporting/schema";

const LAKE_DIR = process.env.CURF_LAKE_DIR ?? "./lake";
const ONLY_MB = process.env.SCAN_SCOPE !== "all";

type Row = Record<string, unknown>;

function defaults(report: Report): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of report.parameters ?? []) out[p.name] = (p as any).default ?? "";
  return out;
}

function bind(sql: string, params: Record<string, unknown>): Record<string, unknown> {
  const bound: Record<string, unknown> = {};
  for (const [, name] of sql.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)) bound[name!] = params[name!] ?? "";
  return bound;
}

async function main() {
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  const { rows } = await pg.query(
    ONLY_MB
      ? `SELECT DISTINCT r.id, r.name, r."tenantId", t.name AS workspace, r.definition,
                (SELECT x->'source'->>'kind' FROM json_array_elements((b."planJson"::json)->'reports') x WHERE x->>'name' = r.name LIMIT 1) AS kind
           FROM "MasterBuildArtifact" a JOIN "Report" r ON r.id = a."refId" JOIN "Tenant" t ON t.id = r."tenantId"
           LEFT JOIN "MasterBuild" b ON b.id = a."buildId"
          WHERE a.kind = 'report' AND a.status = 'ok' ORDER BY t.name, r.name`
      : `SELECT r.id, r.name, r."tenantId", t.name AS workspace, r.definition
           FROM "Report" r JOIN "Tenant" t ON t.id = r."tenantId" ORDER BY t.name, r.name`,
  );
  const lakeSources = new Set((await pg.query(`SELECT id FROM "DataSource" WHERE kind = 'lake'`)).rows.map((r: any) => r.id));
  await pg.end();

  const tally: Record<string, number> = {};
  let checked = 0, clean = 0, partial = 0;
  for (const r of rows) {
    let report: Report;
    try { report = JSON.parse(r.definition); } catch { console.log(`! ${r.workspace} | ${r.name}: definition isn't JSON`); continue; }
    const file = join(LAKE_DIR, `${r.tenantId}.db`);
    const db = existsSync(file) ? new Database(file, { readonly: true, fileMustExist: true }) : null;
    db?.pragma("query_only = ON");
    const dataset: Record<string, Row[]> = {};
    // Each lake table's columns, the way the gate reads them from the catalog:
    // what tells a table kept per period from a snapshot (R10).
    const tableColumns: Record<string, string[]> = {};
    for (const { name } of (db?.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_\\_%' ESCAPE '\\'`).all() ?? []) as Array<{ name: string }>) {
      tableColumns[name] = (db!.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all() as Array<{ name: string }>).map((c) => c.name);
    }
    let skipped = 0;
    for (const ds of report.dataSources ?? []) {
      if (!ds.sql || !db || !lakeSources.has(ds.dataSourceId)) { skipped++; continue; }
      try { dataset[ds.id] = db.prepare(ds.sql).all(bind(ds.sql, defaults(report))) as Row[]; }
      catch { dataset[ds.id] = []; }
    }
    db?.close();

    const blocks = (report.pages ?? []).flatMap((p) => p.blocks ?? []);
    const caption = blocks.find((b: any) => b.type === "text" && b.config?.size === "md")?.config as any;
    const subtitle = (blocks.find((b) => b.type === "title")?.config as any)?.subtitle;
    // Figures in prose can only be checked against every query's rows, and
    // only prose a model wrote is held to them (R4) — the gate's own rule.
    const text = skipped === 0 && authorshipOf(subtitle, r.kind ?? undefined) === "ai" ? { caption: caption?.text, subtitle } : {};
    const found: Violation[] = detectViolations(report, dataset, { ...text, tableColumns }).filter((v) => !(v.rule === "R6" && v.fix));
    checked++;
    if (skipped > 0) partial++;
    if (found.length === 0) { clean++; continue; }
    const title = (id: string) => {
      const b = blocks.find((x) => x.id === id) as any;
      return b ? `“${b.config?.title ?? b.config?.label ?? b.id}”` : id;
    };
    console.log(`\n${r.workspace} | ${r.name}${skipped ? `  (${skipped} non-lake quer${skipped === 1 ? "y" : "ies"} not run)` : ""}`);
    for (const v of found) {
      tally[v.rule] = (tally[v.rule] ?? 0) + 1;
      const what =
        v.rule === "R1" ? `${title(v.target)} returns more rows than its title's count` :
        v.rule === "R2" ? `${title(v.target)} names a condition its SQL doesn't apply` :
        v.rule === "R3" ? `${title(v.target)} names a different calculation than its SQL` :
        v.rule === "R4" ? v.detail :
        v.rule === "R10" ? `${title(v.target)} adds up a balance across periods` :
        v.rule === "R11" ? `${title(v.target)} names two numbers but shows one` :
        `${title(v.target)} has more categories than fit`;
      console.log(`  ${v.rule}  ${what}`);
    }
  }
  console.log(`\nChecked ${checked} report(s): ${clean} clean, ${checked - clean} with findings${partial ? ` (${partial} only partly — non-lake sources aren't run here)` : ""}.`);
  console.log("By rule:", Object.entries(tally).map(([k, v]) => `${k}×${v}`).join("  ") || "none");
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
