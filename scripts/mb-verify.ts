/**
 * Opens a built app in a browser, tab by tab and language by language, and
 * says what a reader would see wrong with it — as machine-readable Findings
 * (src/lib/master-builder/verify/types.ts) and a short human summary. Local
 * development only: it signs in as the seeded dev admin and refuses a
 * non-local server. READ-ONLY unless --repair.
 *
 *   npx tsx scripts/mb-verify.ts <workspaceSlug> <appSlug> [options]
 *
 * What it checks (finding kinds): query-failed, empty-block, chart-empty,
 * chart-flat, kpi-blank, kpi-raw-currency, raw-column-name, card-scrolls,
 * card-gap, text-clipped, table-overflow, label-offframe, label-overlap,
 * untranslated, wrong-language, drilldown-dead, whatif-dead, page-error,
 * console-error, tab-missing — and, from the saved definitions and their
 * results (no browser; the gate's rules R12-R22): kpi-no-plan, kpi-no-drill,
 * unreadable-field, series-reversed, scope-drift, share-out-of-range,
 * unformatted-number, translation-drift, inconsistent-metric, value-out-of-range
 * (an amount shown as a percent), ratio-scope, gap-inconsistent, blank-cell,
 * implausible-outlier; a percent that looks wrong carries its numerator and
 * denominator, run as the reader. With --repair: repair-reverted (a repair that
 * would have dropped a map, a chart kind, a KPI or a plan is not kept).
 *
 * The first locale is the structural pass (everything above); the others only
 * check words and fit (text-clipped, table-overflow, untranslated,
 * wrong-language, raw money, labels) because their data is the same.
 *
 * Options:
 *   --locales en,th,zh      languages to open (default en,th,zh)
 *   --tabs a,b              only these tabs (a label in any language)
 *   --allow-words a,b       Latin words that may stay in a Thai/Chinese page, added to the built-in list
 *   --no-drill              skip the drill-down clicks
 *   --no-whatif             skip the What-if check
 *   --no-defs               skip the definition checks (targets, series order, scope, decimals, translations, one measure two values)
 *   --brief <file>          the brief the app was built from (kept with the result, so a reader of the output sees what was asked)
 *   --summary <file>        an MB_SUMMARY json (mb-build); its briefDelivery (tabs/charts asked vs built) is copied into the output
 *   --no-hover              skip the tooltip check (hovers a mark of every chart/heatmap/map: money must not print whole)
 *   --repair                apply the deterministic repairs (titles, columns, compact money, table heights, drill-downs,
 *                           plans, bars laid down for long category names, missing translations via the fast model)
 *                           through the report gate and the content guard (no repair may drop what the report held),
 *                           repair a What-if whose inputs point at blocks that are gone, then verify again
 *   --rounds <n>            with --repair: repair passes at most (default 2; a translation can need shortening in its turn)
 *   --no-translate          with --repair: do not ask the model for missing translations
 *   --shots <dir>           save a full-page screenshot of every tab view
 *   --out <file>            also write the full result JSON there
 *   --min-severity <s>      what the summary lists and the exit code counts: info | warn (default) | error
 *   --base <url>            server (default http://localhost:3100)
 *
 * Exit: 0 nothing at warn or above, 1 warnings, 2 errors, 3 the check itself failed.
 */
import fs from "node:fs";
import { prisma } from "../src/lib/db";
import { DEFAULT_ALLOWED_WORDS } from "../src/lib/master-builder/verify/text";
import { atLeast, countByKind, countBySeverity, exitCodeFor, type Finding, type Locale, type Severity } from "../src/lib/master-builder/verify/types";
import { verifyApp, type VerifyResult } from "./mb-verify/browser";
import { repairDeterministic } from "./mb-verify/repair";
import { revertedFinding } from "./mb-verify/guard";

export function summarize(r: VerifyResult, min: Severity = "warn"): string {
  const lines = [`mb-verify ${r.workspace}/${r.app}: ${r.tabViews} tab views in ${r.seconds}s — errors ${r.bySeverity.error}, warnings ${r.bySeverity.warn}, info ${r.bySeverity.info}`];
  const shown = r.findings.filter((f) => atLeast(f, min));
  const byTab = new Map<string, Finding[]>();
  for (const f of shown) (byTab.get(`${f.locale} · ${f.tab}`) ?? byTab.set(`${f.locale} · ${f.tab}`, []).get(`${f.locale} · ${f.tab}`)!).push(f);
  for (const [tab, list] of byTab) {
    lines.push(`  ${tab}`);
    for (const f of list) lines.push(`    [${f.severity}] ${f.kind}${f.blockTitle ? ` — ${f.blockType} "${f.blockTitle.slice(0, 40)}"` : ""}: ${f.detail}`);
  }
  if (Object.keys(r.byKind).length) lines.push(`  by kind: ${Object.entries(r.byKind).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  return lines.join("\n");
}

function parse(argv: string[]) {
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  const bool = new Set(["no-drill", "no-whatif", "no-hover", "no-defs", "repair", "no-translate"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const key = a.slice(2);
    if (!bool.has(key) && argv[i + 1] !== undefined) flags.set(key, argv[++i]!); else flags.set(key, true);
  }
  if (pos.length < 2) { console.error("usage: npx tsx scripts/mb-verify.ts <workspaceSlug> <appSlug> [--locales en,th,zh] [--tabs a,b] [--repair] [--out file] ..."); process.exit(64); }
  const list = (k: string) => (typeof flags.get(k) === "string" ? (flags.get(k) as string).split(",").map((s) => s.trim()).filter(Boolean) : []);
  return {
    workspace: pos[0]!, appSlug: pos[1]!, base: (flags.get("base") as string) ?? "http://localhost:3100",
    locales: (list("locales").length ? list("locales") : ["en", "th", "zh"]) as Locale[], onlyTabs: list("tabs"),
    allowWords: [...DEFAULT_ALLOWED_WORDS, ...list("allow-words")], defs: !flags.has("no-defs"), brief: flags.get("brief") as string | undefined, summary: flags.get("summary") as string | undefined, drill: !flags.has("no-drill"), whatIf: !flags.has("no-whatif"), hover: !flags.has("no-hover"),
    repair: flags.has("repair"), translate: !flags.has("no-translate"), shots: flags.get("shots") as string | undefined,
    rounds: Number(flags.get("rounds") ?? 2), out: flags.get("out") as string | undefined, min: ((flags.get("min-severity") as Severity) ?? "warn"),
  };
}

async function main() {
  const o = parse(process.argv.slice(2));
  if (o.shots) fs.mkdirSync(o.shots, { recursive: true });
  const t0 = Date.now();
  const log = (...a: unknown[]) => console.error(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
  // A title code and the model could not shorten safely stays as it is: the card shows an ellipsis and a tooltip, so it is noted, not a warning.
  const unshortenable = new Set<string>();
  const run = async () => {
    const r = await verifyApp({ ...o, log });
    r.findings = r.findings.map((f) => f.kind === "text-clipped" && f.suggestedFix.action === "shorten-title" && unshortenable.has(`${f.blockId}|${f.locale}|${f.suggestedFix.params?.text ?? ""}`)
      ? { ...f, severity: "info" as const, detail: `${f.detail} (could not shorten safely: the card shows an ellipsis and a tooltip)`, suggestedFix: { ...f.suggestedFix, autofix: false } } : f);
    r.byKind = countByKind(r.findings);
    r.bySeverity = countBySeverity(r.findings);
    return r;
  };
  let result = await run();
  let repaired: unknown = null;
  const repairs: unknown[] = [];
  const whatIfRepairs: unknown[] = [];
  const reverts: Finding[] = [];
  for (let round = 1; o.repair && round <= o.rounds; round++) {
    // A KPI that could open its rows is a note (info), not a defect, but --repair still adds the drill-down.
    const fixable = result.findings.filter((f) => (atLeast(f, "warn") || f.kind === "kpi-no-drill") && f.suggestedFix.autofix);
    const whatIfDead = result.findings.some((f) => f.kind === "whatif-dead");
    if (fixable.length === 0 && !whatIfDead) break;
    const tenant = await prisma.tenant.findUnique({ where: { slug: o.workspace }, select: { id: true } });
    const user = await prisma.user.findFirst({ where: { email: process.env.MB_EMAIL ?? "admin@curf.local" }, select: { id: true } });
    if (!tenant || !user) throw new Error("no workspace or dev admin to repair as");
    if (round === 1) console.error(summarize(result, o.min));
    log(`repair round ${round}: ${fixable.length} finding(s) code can fix…`);
    const outcomes = fixable.length ? await repairDeterministic({ tenantId: tenant.id, userId: user.id, findings: fixable, translate: o.translate, appSlug: o.appSlug, log }) : [];
    repairs.push(outcomes);
    repaired = repairs;
    // A What-if whose inputs point at blocks that are gone: rebound (or rebuilt from the KPIs that exist) by Master Builder's own repair.
    let whatIfFixed = false;
    if (whatIfDead) {
      const mod: any = await import("../src/lib/master-builder/whatIfRepair").catch(() => null);
      const app: any = await (prisma as any).app.findFirst({ where: { tenantId: tenant.id, slug: o.appSlug }, select: { id: true } });
      if (mod?.repairDeadWhatIf && app) {
        const w = await mod.repairDeadWhatIf({ tenantId: tenant.id, appId: app.id });
        whatIfRepairs.push(w);
        whatIfFixed = !!w.repaired;
        log(`what-if repair: ${w.mode} - ${w.note}`);
      } else log("what-if repair: not available");
    }
    // What a repair would have taken away is a finding of its own, kept to the end of the run.
    for (const r of outcomes) if (r.reverted && !r.saved) reverts.push(revertedFinding({ reportId: r.reportId, name: r.name, losses: r.reverted, how: "reverted" }));
    for (const r of outcomes) for (const u of r.unshortenable) unshortenable.add(`${u.blockId}|${u.locale}|${u.text}`);
    for (const r of outcomes) log(`${r.name}: ${r.saved ? "saved" : "not saved"}; ${r.applied.length} fix(es), ${r.translated} translation(s)${r.note ? ` — ${r.note}` : ""}`);
    result = await run();
    if (!outcomes.some((r) => r.saved) && !whatIfFixed) break;
  }
  if (reverts.length) { result.findings.push(...reverts); result.byKind = countByKind(result.findings); result.bySeverity = countBySeverity(result.findings); }
  console.error(summarize(result, o.min));
  const readJson = (file?: string) => { try { return file ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined; } catch { return undefined; } };
  const summary = readJson(o.summary);
  const briefDelivery = summary?.briefDelivery ?? summary?.mb?.briefDelivery;
  const payload = { ...result, repaired, ...(whatIfRepairs.length ? { whatIfRepairs } : {}), ...(o.brief ? { brief: fs.readFileSync(o.brief, "utf8") } : {}), ...(briefDelivery ? { briefDelivery } : {}) };
  if (o.out) fs.writeFileSync(o.out, JSON.stringify(payload, null, 2));
  console.log("MB_VERIFY " + JSON.stringify({ workspace: result.workspace, app: result.app, tabViews: result.tabViews, bySeverity: result.bySeverity, byKind: result.byKind, seconds: result.seconds, ...(reverts.length ? { reverted: reverts.map((r) => r.detail) } : {}), ...(whatIfRepairs.length ? { whatIf: whatIfRepairs } : {}), ...(briefDelivery ? { briefDelivery } : {}) }));
  await prisma.$disconnect();
  process.exit(exitCodeFor(result.findings.filter((f) => atLeast(f, o.min))));
}

if (process.argv[1] && /mb-verify\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) {
  main().catch(async (e) => { console.error(e?.message ?? e); await prisma.$disconnect().catch(() => {}); process.exit(3); });
}
