/**
 * Re-run the pre-publish gate (src/lib/intelligence/reportGate.ts) on
 * reports already saved — ones generated before every generated report had
 * to pass it. scan.ts finds them; this fixes them.
 *
 * Two steps, so what is saved is exactly what was reviewed (the review asks
 * a model, which won't answer the same way twice):
 *   - review (default): runs the gate and prints what it would change;
 *     OUT=<file> also writes the result;
 *   - APPLY=1 FROM=<file>: saves those reviewed definitions — each after
 *     writing the current one as a ReportVersion (the version history
 *     restores it in one click), skipping any report edited since the
 *     review — and records an AuditEvent per report.
 *
 * Runs the way the gate runs for a new report — every query as the report's
 * creator, the workspace's own AI settings for the review — with two
 * differences for a report people have been reading:
 *   - `existing`: a block is flagged, not removed — whether it has no data
 *     right now or its words don't match its query and review didn't fix them;
 *   - three repairs that need no judgement run first, because the generator
 *     that made these reports got them wrong (autoCurf.ts no longer does):
 *       · a KPI labelled "<column> is null" ("<column> เป็น null") over
 *         COUNT(*) of the whole table counts only those rows (kpiCondition),
 *         when the column is really in its table;
 *       · a KPI labelled "Total …" whose SQL averages says "Avg …" — the
 *         relabel the generator itself applies (relabelForAvg);
 *       · a chart that sums a ratio column averages it (chartAggregateExpr's
 *         rule, looksLikePercent).
 *
 * In the app's pod (DATABASE_URL, the lakes and the AI settings are there):
 *   node node_modules/esbuild/bin/esbuild scripts/report-rules/recheck.ts --bundle --platform=node \
 *     --format=cjs --packages=external --outfile=recheck.cjs
 *   kubectl -n curfai exec -i <pod> -c curfai -- sh -c 'cd /app && REPORT_IDS=<id,id> OUT=/tmp/recheck.json node -' < recheck.cjs
 *   kubectl -n curfai exec -i <pod> -c curfai -- sh -c 'cd /app && APPLY=1 FROM=/tmp/recheck.json node -' < recheck.cjs
 */
import Database from "better-sqlite3";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { prisma } from "@/lib/db";
import { persistAudit } from "@/lib/audit";
import { memberViewer } from "@/lib/reporting/exportCaller";
import { ReportSchema, type Report } from "@/lib/reporting/schema";
import { gateGeneratedReport, persistableDefinition } from "@/lib/intelligence/reportGate";
import { kpiCondition, looksLikePercent, relabelForAvg } from "@/lib/intelligence/autoCurf";
import { authorshipOf } from "@/lib/intelligence/reportRules";

const APPLY = process.env.APPLY === "1";
const OUT = process.env.OUT;
const FROM = process.env.FROM;
const IDS = (process.env.REPORT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const LAKE_DIR = process.env.CURF_LAKE_DIR ?? "./lake";

/** Columns of a lake table, read from the lake file itself (read-only). */
function lakeColumns(tenantId: string, table: string): Set<string> {
  const file = join(LAKE_DIR, `${tenantId}.db`);
  if (!existsSync(file)) return new Set();
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return new Set((db.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all() as Array<{ name: string }>).map((c) => c.name));
  } finally { db.close(); }
}

/** The repairs that need no judgement — see the header. Returns what was done. */
function repair(report: Report, tenantId: string): string[] {
  const done: string[] = [];
  for (const b of report.pages.flatMap((p) => p.blocks)) {
    // A chart that sums a ratio ("NPL ratio by branch") shows a number with
    // no meaning; the generator averages ratio columns (chartAggregateExpr).
    if (b.type === "chart") {
      const cfg = b.config as any;
      const ds = report.dataSources.find((d) => d.id === cfg.queryId);
      for (const y of (cfg.yFields ?? []) as string[]) {
        const summed = new RegExp(`SUM\\(CAST\\("${y.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" AS (DOUBLE|REAL)\\)\\)`, "i");
        if (ds?.sql && looksLikePercent(y) && summed.test(ds.sql)) {
          ds.sql = ds.sql.replace(summed, (_m, type) => `AVG(CAST("${y}" AS ${type}))`);
          done.push(`“${cfg.title}” averages ${y} instead of summing a ratio`);
        }
      }
      continue;
    }
    if (b.type !== "kpi") continue;
    const cfg = b.config as any;
    const ds = report.dataSources.find((d) => d.id === cfg.queryId);
    if (!ds?.sql || typeof cfg.valueField !== "string" || typeof cfg.label !== "string") continue;
    const alias = cfg.valueField.replace(/"/g, '""');
    const table = ds.sql.match(/\bFROM\s+"([^"]+)"/i)?.[1];

    const nullCol = cfg.label.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:เป็น|is)\s*null\b/i)?.[1];
    const countStar = new RegExp(`COUNT\\(\\*\\)\\s+AS\\s+"${alias}"`, "i");
    if (nullCol && table && countStar.test(ds.sql)) {
      const cols = lakeColumns(tenantId, table);
      const col = [...cols].find((c) => c.toLowerCase() === nullCol.toLowerCase());
      const cond = col ? kpiCondition({ field: col, op: "is_null" }, cols) : null;
      if (cond) {
        ds.sql = ds.sql.replace(countStar, `COUNT(CASE WHEN ${cond} THEN 1 END) AS "${alias}"`);
        done.push(`“${cfg.label}” now counts only rows where ${col} is empty`);
      }
    }

    const averaged = new RegExp(`AVG\\([^()]*(?:\\([^()]*\\))?[^()]*\\)(?:\\s*/\\s*100\\.0\\))?\\s+AS\\s+"${alias}"`, "i").test(ds.sql);
    const relabeled = relabelForAvg(cfg.label, averaged);
    if (relabeled && relabeled !== cfg.label) {
      done.push(`“${cfg.label}” → “${relabeled}” (its SQL averages)`);
      cfg.label = relabeled;
    }
  }
  return done;
}

type Reviewed = { id: string; version: number; definition: string; repairs: string[]; quality: unknown; verdict: string };

async function review(): Promise<Reviewed[]> {
  if (IDS.length === 0) throw new Error("set REPORT_IDS=<id,id,…>");
  const out: Reviewed[] = [];
  for (const id of IDS) {
    const row = await prisma.report.findUnique({
      where: { id },
      select: { id: true, name: true, tenantId: true, definition: true, version: true, description: true, createdById: true, tenant: { select: { name: true, currency: true } } },
    });
    if (!row) { console.log(`\n${id}: not found`); continue; }
    const report = ReportSchema.parse(JSON.parse(row.definition));
    const blocks = report.pages.flatMap((p) => p.blocks);
    const subtitle = (blocks.find((b) => b.type === "title")?.config as any)?.subtitle as string | undefined;
    const plan = await prisma.masterBuildArtifact.findFirst({ where: { refId: row.id, kind: "report" }, select: { build: { select: { planJson: true } } } });
    const kind = (() => {
      try { return (JSON.parse(plan?.build?.planJson ?? "{}").reports ?? []).find((r: any) => r.name === row.name)?.source?.kind; } catch { return undefined; }
    })();
    const authored = authorshipOf(subtitle, kind);
    const caption = (blocks.find((b) => b.type === "text" && (b.config as any)?.size === "md")?.config as any)?.text as string | undefined;
    const text = [report.name, subtitle, caption].join(" ");

    const repairs = repair(report, row.tenantId);
    const gate = await gateGeneratedReport({
      report, tenantId: row.tenantId, userId: row.createdById,
      viewer: await memberViewer(row.tenantId, row.createdById ?? ""),
      authored, existing: true,
      prompt: row.description || row.name, caption,
      locale: /[฀-๿]/.test(text) ? "th" : /[一-鿿]/.test(text) ? "zh" : "en",
      tenantCurrency: row.tenant.currency,
    });

    console.log(`\n${row.tenant.name} | ${row.name}  (v${row.version ?? 1}, ${authored}, reviewed: ${gate.quality.reviewed}, verdict: ${gate.verdict})`);
    for (const r of repairs) console.log(`  repair   ${r}`);
    for (const c of gate.quality.changes) console.log(`  ${c.kind.padEnd(8)} ${[c.title && `“${c.title}”`, c.to && `→ “${c.to}”`, c.n && `${c.n} rows`, c.reason].filter(Boolean).join(" ")}`);
    for (const f of gate.quality.flags) console.log(`  flag     ${f.rule} ${f.title ? `“${f.title}”` : ""}`);
    for (const n of gate.quality.notes) console.log(`  note     ${n}`);
    const after = gate.report.pages.flatMap((p) => p.blocks);
    const newCaption = (after.find((b) => b.type === "text" && (b.config as any)?.size === "md")?.config as any)?.text;
    const newSubtitle = (after.find((b) => b.type === "title")?.config as any)?.subtitle;
    if (caption !== newCaption) console.log(`  caption  ${newCaption ? `“${newCaption}”` : "(left out)"}`);
    if (subtitle !== newSubtitle) console.log(`  subtitle ${newSubtitle ? `“${newSubtitle}”` : "(left out)"}`);
    if (gate.verdict === "fail") { console.log("  skipped  the gate failed it — left as it is"); continue; }
    out.push({ id: row.id, version: row.version ?? 1, definition: persistableDefinition(gate), repairs, quality: gate.quality, verdict: gate.verdict });
  }
  return out;
}

/** Save exactly what was reviewed — the review's model output isn't asked for again. */
async function apply(reviewed: Reviewed[]) {
  for (const r of reviewed) {
    const row = await prisma.report.findUnique({ where: { id: r.id }, select: { id: true, name: true, tenantId: true, definition: true, version: true } });
    if (!row) { console.log(`${r.id}: gone — skipped`); continue; }
    if ((row.version ?? 1) !== r.version) { console.log(`${row.name}: edited since the review (v${row.version}, reviewed v${r.version}) — skipped`); continue; }
    ReportSchema.parse(JSON.parse(r.definition));
    await prisma.$transaction([
      prisma.reportVersion.create({
        data: { tenantId: row.tenantId, reportId: row.id, version: r.version, definition: row.definition, note: "Before the report rules re-check (2026-09-28)", createdById: null },
      }),
      prisma.report.update({ where: { id: row.id }, data: { definition: r.definition, version: r.version + 1 } }),
    ]);
    await persistAudit({
      tenantId: row.tenantId, userId: null, kind: "report.recheck", target: row.id,
      meta: { from: r.version, to: r.version + 1, repairs: r.repairs, quality: r.quality, verdict: r.verdict },
    });
    console.log(`${row.name}: saved v${r.version + 1} (v${r.version} kept in version history)`);
  }
}

async function main() {
  if (APPLY) {
    if (!FROM) throw new Error("APPLY=1 needs FROM=<the file a review wrote>");
    console.log(`APPLY — saving what was reviewed in ${FROM}, each with a version to roll back to`);
    await apply(JSON.parse(readFileSync(FROM, "utf8")));
  } else {
    console.log("Review — nothing is saved");
    const reviewed = await review();
    if (OUT) { writeFileSync(OUT, JSON.stringify(reviewed)); console.log(`\nWrote ${reviewed.length} reviewed report(s) to ${OUT} — apply them with APPLY=1 FROM=${OUT}`); }
  }
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e?.message ?? e); await prisma.$disconnect(); process.exit(1); });
