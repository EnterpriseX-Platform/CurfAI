/**
 * The one gate every generated report passes before it is saved or shown.
 *
 * Generated reports used to be checked where each entry point remembered
 * to: the instant-view route ran instantViewQa, the auto-generate route
 * copied that in later, and Master Builder — which calls the same
 * generators — never did, so its reports were saved straight from the
 * model's design: a "Top 10" chart of 50 rows, a KPI whose label named a
 * filter its SQL never applied, a caption quoting sample rows (2026-09-28).
 * Now there is one gate, and saving needs what only it returns:
 * `persistableDefinition(result)` takes a GateResult, refuses a failed one,
 * and tests/audit/report-gate-completeness.test.ts fails any file that
 * generates a report and saves it another way.
 *
 * In order:
 *   1. every query runs as the reader the report is built for;
 *   2. code fixes what it can by itself (reportRules.ts): a promised
 *      "Top N" limits its query to N, a bar chart gets the height its
 *      bars need;
 *   3. instantViewQa checks the definition, drops empty blocks, sanity-
 *      checks the numbers, and has the fast model review the report against
 *      the rules and the remaining flags — it may retitle, limit or remove a
 *      block, rewrite the caption/subtitle from the results, or confirm a
 *      flag with a reason; it never writes SQL;
 *   4. the flags are checked again, and code enforces what is still wrong:
 *      on an AI-written report a block whose words don't match its query is
 *      removed and a caption stating figures the results don't show is
 *      left out; a template's hand-written words are kept with a note;
 *   5. the report is stamped with what was checked and changed
 *      (`quality`), which its readers see.
 */
import { runReportWithProof, type RunViewer } from "@/lib/reporting/runner";
import { computeKpiValue } from "@/lib/reporting/kpi";
import { neededQueries } from "@/lib/reporting/queryRefs";
import { ReportSchema, type Report, type ReportQuality } from "@/lib/reporting/schema";
import { applyAverageLines } from "./averageLines";
import type { KpiAsk } from "./kpiMatch";
import { qaInstantView, type QaCheck, type QaResult } from "./instantViewQa";
import { applyRuleFix, applyScriptFix, blockTitle, detectViolations, resizeBlock, queryIdOf, quotableStrings, topNFromTitle, withLimit, type Dataset, type NumberRuleFix, type Violation } from "./reportRules";
import { sanitizeNarrative } from "./narrativeChecks";
import { compactRows, pickRateParts, rateProbeSql, tablesRead, type RateParts } from "./reportRulesNumbers";
import { prisma } from "@/lib/db";
import { ee } from "@/ee";
import { parseSchemaJson } from "@/lib/lake/schemaGovernance";

declare const GATED: unique symbol;

export type GateResult = {
  readonly [GATED]: true;
  report: Report;
  verdict: QaResult["verdict"];
  checks: QaCheck[];
  removed: QaResult["removed"];
  dataset: Dataset;
  queryErrors: Record<string, string>;
  quality: ReportQuality;
};

/** Which blocks the gate took out of a failed report and why (a failed query, no rows, a rule), most telling first. */
export function failureDetail(result: Pick<GateResult, "removed" | "quality" | "queryErrors">): string {
  const parts = [
    ...result.removed.map((r) => `"${r.title.slice(0, 40)}": ${r.reason.slice(0, 140)}`),
    ...(result.quality?.changes ?? []).filter((c) => c.kind === "removed").map((c) => `"${String(c.title ?? "").slice(0, 40)}" removed${c.rule ? ` by ${c.rule}` : ""}${c.reason ? `: ${String(c.reason).slice(0, 140)}` : ""}`),
  ];
  const errors = Object.values(result.queryErrors ?? {});
  if (parts.length === 0 && errors.length) parts.push(`${errors.length} query error(s): ${errors[0]!.slice(0, 140)}`);
  const shown = parts.slice(0, 6).join("; ");
  return parts.length > 6 ? `${shown}; +${parts.length - 6} more` : shown;
}

/**
 * The definition to save for a generated report — the only way to get one
 * from the gate's result. A report that failed its checks is not saved.
 */
export function persistableDefinition(result: GateResult): string {
  if (result.verdict === "fail") {
    const why = result.checks.find((c) => c.status === "fail")?.detail ?? "it failed its checks";
    const detail = failureDetail(result);
    // The draft is not kept, so what emptied it has to be in the message (build notes) and the server log.
    if (detail) console.warn(`[gate] report not saved: ${why} - ${detail}`);
    throw new Error(`report not saved: ${why}${detail ? ` (${detail})` : ""}`);
  }
  return JSON.stringify(result.report);
}

/**
 * Rules about a block's words matching its query (reportRules.ts): the
 * reviewer may fix the words, remove the block, or confirm it with a reason;
 * an AI-written block that still breaks one after review is removed.
 */
const CONFIRMABLE = new Set<Violation["rule"]>(["R2", "R3", "R10", "R11"]);

type Change = ReportQuality["changes"][number];
type Flag = ReportQuality["flags"][number];

export async function gateGeneratedReport(args: {
  report: Report;
  tenantId: string;
  /** Who the report is built for — its queries run as them, so a figure it states is one they may see. */
  viewer: RunViewer;
  userId?: string | null;
  /** "ai" when a model wrote its words; "template" for a pack, a template or the rule-based layout. */
  authored: "ai" | "template";
  /**
   * A report already saved being re-checked (scripts/report-rules/recheck.ts):
   * a block with no data right now is flagged, not removed — people may be
   * relying on it, and its data can come back.
   */
  existing?: boolean;
  /**
   * The verifier's own repair of a saved report (master-builder/verify/repairDeterministic.ts). A figure people already read changes
   * only when the verifier's repair says so: this says so, for R26 (an average of a rate becomes the sum of its parts over the sum).
   */
  repair?: boolean;
  /** What the report was asked to answer. */
  prompt: string;
  /** The generator's caption text, so it can be checked and, if needed, found and replaced. */
  caption?: string;
  /** Defaults to the title block's subtitle. */
  subtitle?: string;
  locale?: "en" | "th" | "zh";
  tenantCurrency?: string | null;
  averageLineBlockIds?: string[];
  /** The KPIs the brief named, each with the target it gave: a KPI that is one of them holds that target as its plan (R12). */
  kpiAsks?: KpiAsk[];
  /** Before each query runs, and each one's result as it lands — the instant-view stream shows them live. */
  onQueryStart?: (e: { n: number; total: number; name: string }) => void;
  onQuery?: (e: { queryId: string; name: string; n: number; total: number; rows: Dataset[string]; proof: unknown; error?: string }) => void;
  onChecking?: () => void;
  signal?: AbortSignal;
}): Promise<GateResult> {
  let report: Report = structuredClone(args.report);
  // A KPI that names one of the workspace's defined metrics reads the defined SQL, not the model's own (lib/metrics).
  if (args.authored === "ai" && !args.existing) {
    try { report = (await ee.metrics?.governReport?.(report, { tenantId: args.tenantId, viewer: args.viewer }))?.report ?? report; }
    catch (e: any) { console.warn("[gate] governed metrics skipped:", e?.message); }
  }
  let caption = args.caption?.trim() || undefined;
  let subtitle = (args.subtitle ?? titleSubtitle(report))?.trim() || undefined;
  const changes: Change[] = [];
  const notes: string[] = [];
  const flags: Flag[] = [];
  // R4 is about prose a model wrote from sample rows before any query ran. A
  // template's copy is written from the data itself ("360 rows · 4 columns"
  // from the table's own catalog), so its figures aren't held to the results.
  const prose = () => (args.authored === "ai" ? { caption, subtitle } : {});

  // 1. Every query, as the reader.
  const { dataset, queryErrors } = await runQueries(report, args);
  const tableColumns = await lakeTableColumns(args.tenantId);
  const checks = () => ({ ...prose(), tableColumns, kpiAsks: args.kpiAsks, locale: args.locale });
  // Drill queries the code wrote (R18) are run once each, so a drill-down that opens nothing is never kept.
  const drillsChecked = new Map<string, boolean>();
  if (args.averageLineBlockIds?.length) report = applyAverageLines(report, dataset, args.averageLineBlockIds);

  // 2. What code fixes by itself.
  report = await applyCodeFixes(report, dataset, queryErrors, args, changes, checks(), drillsChecked);

  // 3. The checks and the review, told what is still flagged.
  args.onChecking?.();
  const flagged = detectViolations(report, dataset, checks()).filter((v) => !v.fix);
  // Only prose a model wrote goes to the reviewer to be rewritten. Told a
  // hand-written subtitle came "from sample rows", it rewrote a correct
  // "items the OLD method provisioned" into "items the NEW method
  // provisioned" on a client's presentation (2026-09-28).
  const aiProse = args.authored === "ai";
  const qa = await qaInstantView({
    report, dataset, queryErrors, prompt: args.prompt,
    caption: aiProse ? caption : undefined, subtitle: aiProse ? subtitle : undefined,
    violations: flagged, keepEmptyBlocks: args.existing,
    locale: args.locale, tenantCurrency: args.tenantCurrency, tenantId: args.tenantId, userId: args.userId, signal: args.signal,
  });
  if (qa.verdict === "fail") return stamp(qa.report, qa, args, changes, notes, flags, dataset, queryErrors);
  report = qa.report;
  for (const r of qa.removed) changes.push({ kind: "removed", rule: "R5", title: r.title, reason: r.reason });
  for (const e of qa.empty) flags.push({ rule: "R5", title: e.title });
  if (caption && qa.caption && qa.caption !== caption) changes.push({ kind: "captionRewritten", rule: "R4" });
  if (subtitle && qa.subtitle && qa.subtitle !== subtitle) changes.push({ kind: "subtitleRewritten", rule: "R4" });
  if (aiProse) {
    caption = qa.caption;
    subtitle = qa.subtitle;
  }

  // The reviewer's fixes — only the three kinds, each checked by code
  // before it is applied: the model proposes, the rules decide. A re-check
  // of an existing report showed why (2026-09-28): unchecked, it deleted a
  // detail table it merely found dull, turned English labels Thai, and wrote
  // "(SUM)" and column names into labels meant for executives.
  const ruleFlagged = new Set(flagged.filter((v) => CONFIRMABLE.has(v.rule)).map((v) => v.target));
  // Renames first, so a limit is judged against the title it will show under.
  const ordered = [...qa.review.ops].sort((a, b) => (a.op === "retitle" ? 0 : 1) - (b.op === "retitle" ? 0 : 1));
  for (const op of ordered) {
    const block = findBlock(report, op.target);
    if (!block) continue;
    const cfg = (block as any).config ?? {};
    const title = blockTitle(block);
    if (op.op === "retitle") {
      if (retitleProblem(title, op.text)) continue;
      // On a report people already read, a template's (or a person's) words
      // change only where a rule found them wrong.
      if (args.existing && args.authored === "template" && !ruleFlagged.has(block.id)) continue;
      if (block.type === "kpi") cfg.label = op.text; else cfg.title = op.text;
      changes.push({ kind: "retitled", title, to: op.text });
    } else if (op.op === "limit") {
      const qid = queryIdOf(block);
      // Only a cut that shows fewer rows is a change, and only one the title
      // states: "Budget by province" cut to 15 would hide the other 60
      // under a title that promises all of them.
      if (block.type === "chart" && qid && usersOf(report, qid) === 1 && (dataset[qid]?.length ?? 0) > op.n && topNFromTitle(blockTitle(block)) === op.n) {
        await limitQuery(report, qid, op.n, dataset, queryErrors, args);
        changes.push({ kind: "limited", title: blockTitle(block), n: op.n });
      }
    } else if (ruleFlagged.has(block.id) && !args.existing) {
      // Removal answers a rule a block breaks, on a draft nobody has read yet.
      report = removeBlocks(report, [block.id]);
      changes.push({ kind: "removed", title, reason: op.reason || undefined });
    }
  }

  // 4. Check again; enforce what is still wrong.
  report = await applyCodeFixes(report, dataset, queryErrors, args, changes, checks(), drillsChecked);
  const confirmed = new Map(qa.review.confirmed.map((c) => [`${c.target}:${c.rule}`, c.reason]));
  const drop: string[] = [];
  for (const v of detectViolations(report, dataset, checks())) {
    // A drill-down is an improvement the code adds when it can: one it could not make (no rows) is no flag on the report.
    if (v.rule === "R18") continue;
    // R29/R30 in the prose a model wrote: the sentence (or the leaked script) goes; a caption or subtitle left empty goes too.
    if ((v.rule === "R29" || v.rule === "R30") && (v.target === "caption" || v.target === "subtitle")) {
      const text = v.target === "caption" ? caption : subtitle;
      if (!text) continue;
      const next = sanitizeNarrative(text, { locale: args.locale, allow: quotableStrings(dataset), jargon: false }).text;
      if (v.target === "caption") {
        report = next ? replaceCaption(report, text, next) : removeCaption(report, text);
        caption = next ?? undefined;
        changes.push({ kind: next ? "captionRewritten" : "captionDropped", rule: v.rule, reason: v.detail });
      } else {
        report = setSubtitle(report, next ?? undefined);
        subtitle = next ?? undefined;
        changes.push({ kind: next ? "subtitleRewritten" : "subtitleDropped", rule: v.rule, reason: v.detail });
      }
      continue;
    }
    const reason = confirmed.get(`${v.target}:${v.rule}`);
    if (reason && CONFIRMABLE.has(v.rule)) { notes.push(`${titleFor(report, v)}: ${reason}`); continue; }
    // On a report people already read, a block is flagged rather than taken
    // away; a figure in prose that isn't in the results still goes.
    // A card with no value goes from a new report (as one with no rows does, R5), unless something else names it.
    const noValue = v.rule === "R27" && !args.existing && JSON.stringify(report).split(`"${v.target}"`).length - 1 <= 1;
    // A wrong figure under a rate label is worse than none, so it goes the same way; the build's completion can add it back done properly.
    const notARate = v.rule === "R28" && !args.existing && JSON.stringify(report).split(`"${v.target}"`).length - 1 <= 1;
    // A broken title and an impossible percent are worse than a missing card, so they go the same way.
    const unreadable = (v.rule === "R33" || v.rule === "R34" || v.rule === "R35") && !args.existing && v.target !== "report";
    const hard = noValue || notARate || unreadable || (args.authored === "ai" && (v.rule === "R4" || (!args.existing && CONFIRMABLE.has(v.rule))));
    if (!hard) { flags.push({ rule: v.rule, title: v.target === "caption" || v.target === "subtitle" ? undefined : titleFor(report, v) }); continue; }
    if (v.target === "caption") {
      report = removeCaption(report, caption);
      caption = undefined;
      changes.push({ kind: "captionDropped", rule: "R4", reason: v.detail });
    } else if (v.target === "subtitle") {
      report = setSubtitle(report, undefined);
      subtitle = undefined;
      changes.push({ kind: "subtitleDropped", rule: "R4", reason: v.detail });
    } else {
      drop.push(v.target);
      changes.push({ kind: "removed", rule: v.rule, title: titleFor(report, v), reason: v.detail });
    }
  }
  if (drop.length > 0) report = removeBlocks(report, drop);

  return stamp(report, qa, args, changes, [...qa.review.notes, ...notes], flags, dataset, queryErrors);
}

/** What the gate would take out of an AI-written report on the rules alone: a words-versus-query mismatch, a card with no value, a wrong rate. */
const REMOVING_RULES = new Set<Violation["rule"]>(["R4", "R27", "R28", "R33", "R34", "R35", ...CONFIRMABLE]);

export type GateFinding = { blockId: string; title: string; rule: string; detail: string };

/**
 * The blocks the gate would remove from this draft, found before anything is saved, so the designer that wrote them can be
 * told (Master Builder's designer agent). Runs the queries as the reader and the same checks the gate enforces, without the
 * reviewer model; what code repairs by itself (a promised Top N, a chart's height) is not a finding. A block whose query
 * fails or returns nothing is one too, since the gate removes it.
 */
export async function previewGateFindings(args: {
  report: Report; tenantId: string; viewer: RunViewer; caption?: string; locale?: "en" | "th" | "zh"; kpiAsks?: KpiAsk[]; signal?: AbortSignal;
}): Promise<GateFinding[]> {
  const report = structuredClone(args.report);
  const { dataset, queryErrors } = await runQueries(report, args);
  const tableColumns = await lakeTableColumns(args.tenantId);
  const subtitle = titleSubtitle(report)?.trim() || undefined;
  const found: GateFinding[] = [];
  for (const b of report.pages.flatMap((p) => p.blocks)) {
    const qid = queryIdOf(b);
    if (!qid || (b.config as any)?.drilldown?.queryId === qid) continue;
    if (queryErrors[qid]) found.push({ blockId: b.id, title: blockTitle(b), rule: "query", detail: `its query failed: ${queryErrors[qid]!.slice(0, 160)}` });
    else if ((dataset[qid]?.length ?? 0) === 0) found.push({ blockId: b.id, title: blockTitle(b), rule: "R5", detail: "its query returned no rows" });
  }
  const seen = new Set(found.map((f) => f.blockId));
  for (const v of detectViolations(report, dataset, { caption: args.caption?.trim() || undefined, subtitle, tableColumns, kpiAsks: args.kpiAsks, locale: args.locale })) {
    if (v.fix || !REMOVING_RULES.has(v.rule) || seen.has(v.target)) continue;
    const block = findBlock(report, v.target);
    if (!block) continue;
    seen.add(v.target);
    found.push({ blockId: block.id, title: blockTitle(block), rule: v.rule, detail: v.detail });
  }
  return found;
}

function stamp(
  report: Report, qa: QaResult, args: { authored: "ai" | "template" }, changes: Change[], notes: string[], flags: Flag[],
  dataset: Dataset, queryErrors: Record<string, string>,
): GateResult {
  const dataBlocks = report.pages.flatMap((p) => p.blocks).filter((b) => !!queryIdOf(b));
  const verdict: QaResult["verdict"] =
    qa.verdict === "fail" || dataBlocks.length === 0 ? "fail"
    : qa.verdict === "warn" || changes.some((c) => c.kind === "removed" || c.kind.endsWith("Dropped")) || notes.length > 0 || flags.length > 0 ? "warn"
    : "pass";
  const quality: ReportQuality = {
    checkedAt: new Date().toISOString(),
    verdict,
    authored: args.authored,
    reviewed: qa.review.ran,
    changes,
    flags,
    notes: [...new Set(notes)].slice(0, 8),
  };
  const checks = dataBlocks.length === 0 && qa.verdict !== "fail"
    ? [...qa.checks, { id: "data" as const, label: "Every block has data", status: "fail" as const, detail: "nothing was left that passed the checks" }]
    : qa.checks;
  const parsed = ReportSchema.safeParse({ ...report, quality });
  return {
    report: parsed.success ? parsed.data : { ...report, quality },
    verdict: parsed.success ? verdict : "fail",
    checks: parsed.success ? checks : [...checks, { id: "schema", label: "Definition validates", status: "fail", detail: parsed.error.issues[0]?.message ?? "invalid" }],
    removed: qa.removed,
    dataset,
    queryErrors,
    quality,
  } as GateResult;
}

// ── Queries ────────────────────────────────────────────────────────────

type GateArgs = Parameters<typeof gateGeneratedReport>[0];
type RunArgs = Pick<GateArgs, "tenantId" | "viewer" | "onQuery" | "onQueryStart" | "signal" | "existing" | "repair">;

function defaultParams(report: Report): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const p of report.parameters ?? []) params[p.name] = p.default ?? "";
  return params;
}

async function runQueries(report: Report, args: RunArgs): Promise<{ dataset: Dataset; queryErrors: Record<string, string> }> {
  const dataset: Dataset = {};
  const queryErrors: Record<string, string> = {};
  const total = report.dataSources.length;
  // A query that joins another can't run on its own; run those reports whole.
  if (report.dataSources.some((d) => ((d as any).joins ?? []).length > 0)) {
    try {
      const { dataset: all } = await runReportWithProof({ report, params: defaultParams(report), tenantId: args.tenantId, viewer: args.viewer });
      for (const d of report.dataSources) dataset[d.id] = all[d.id] ?? [];
    } catch (e: any) {
      for (const d of report.dataSources) { dataset[d.id] = []; queryErrors[d.id] = e?.message ?? "Query failed"; }
    }
    return { dataset, queryErrors };
  }
  let n = 0;
  for (const ds of report.dataSources) {
    if (args.signal?.aborted) break;
    n += 1;
    args.onQueryStart?.({ n, total, name: ds.name ?? ds.id });
    await runOne(report, ds.id, dataset, queryErrors, args, n, total);
  }
  return { dataset, queryErrors };
}

async function runOne(report: Report, queryId: string, dataset: Dataset, queryErrors: Record<string, string>, args: RunArgs, n = 1, total = 1): Promise<void> {
  const ds = report.dataSources.find((d) => d.id === queryId);
  if (!ds) return;
  try {
    const { dataset: one, provenance } = await runReportWithProof({
      report: { ...report, dataSources: [ds] }, params: defaultParams(report), tenantId: args.tenantId, viewer: args.viewer,
    });
    dataset[ds.id] = one[ds.id] ?? [];
    delete queryErrors[ds.id];
    args.onQuery?.({ queryId: ds.id, name: ds.name ?? ds.id, n, total, rows: dataset[ds.id]!, proof: provenance[ds.id] ?? null });
  } catch (e: any) {
    queryErrors[ds.id] = e?.message ?? "Query failed";
    dataset[ds.id] = [];
    args.onQuery?.({ queryId: ds.id, name: ds.name ?? ds.id, n, total, rows: [], proof: null, error: queryErrors[ds.id] });
  }
}

/**
 * Why a reviewer's new title can't replace `from`, or null when it can: it
 * must change something, stay in the original's language (Thai, Chinese or
 * Latin script), and add no SQL words or column/table names a business
 * reader wouldn't use.
 */
export function retitleProblem(from: string, to: string): string | null {
  if (to.trim() === from.trim()) return "unchanged";
  const script = (s: string) => (/[\u0E00-\u0E7F]/.test(s) ? "th" : /[\u4E00-\u9FFF]/.test(s) ? "zh" : "latin");
  if (script(from) !== script(to)) return "switches language";
  const sqlWord = /\b(SQL|SUM|AVG|MIN|MAX|COUNT|NULL|WHERE|CASE|where|sql)\b/;
  if (sqlWord.test(to) && !sqlWord.test(from)) return "adds SQL words";
  // A title, not the reviewer's reasoning: "ยอดขายคลังออนไลน์ (ต้องกรอง kind = … ด้วย
  // where ใน KPI — ปัจจุบัน SQL ไม่มีเงื่อนไข …)" went onto a Pet Lovers KPI card.
  if (to.trim().length > Math.max(60, from.trim().length * 2)) return "too long for a title";
  const identifiers = (s: string) => new Set(s.match(/[A-Za-z0-9]+_[A-Za-z0-9_]+/g) ?? []);
  const known = identifiers(from);
  if ([...identifiers(to)].some((id) => !known.has(id))) return "adds a column or table name";
  return null;
}

export { withLimit };

async function limitQuery(report: Report, queryId: string, n: number, dataset: Dataset, queryErrors: Record<string, string>, args: RunArgs): Promise<void> {
  const ds = report.dataSources.find((d) => d.id === queryId);
  if (!ds?.sql) return;
  ds.sql = withLimit(ds.sql, n);
  await runOne(report, queryId, dataset, queryErrors, { ...args, onQuery: undefined });
}

/**
 * The workspace's lake tables' columns, by table: what tells a table kept per
 * period from a snapshot (R10). Best effort — without them R10 reads the
 * query itself for a period column.
 */
export async function lakeTableColumns(tenantId: string): Promise<Record<string, string[]> | undefined> {
  try {
    const tables = await prisma.lakeTable.findMany({ where: { tenantId }, select: { name: true, schemaJson: true } });
    return Object.fromEntries(tables.map((t) => [t.name, parseSchemaJson(t.schemaJson).map((c) => c.name)]));
  } catch {
    return undefined;
  }
}

/**
 * R26: for each KPI that averages a rate column, which two columns of its table the rate is the ratio of. Found by
 * asking the table's own rows (the pair that reproduces the rate on every row, within its rounding), run as the
 * reader; no pair, no rewrite - the rule then only flags.
 */
async function probeRateParts(
  report: Report, dataset: Dataset, text: { caption?: string; subtitle?: string; tableColumns?: Record<string, string[]>; kpiAsks?: KpiAsk[] }, args: RunArgs,
): Promise<Record<string, RateParts>> {
  const wanted = new Map<string, { table: string; column: string }>();
  for (const v of detectViolations(report, dataset, text)) if (v.rule === "R26" && v.probe) wanted.set(`${v.probe.table}.${v.probe.column}`, v.probe);
  if (wanted.size === 0) return {};
  const lake = await prisma.lakeTable.findMany({ where: { tenantId: args.tenantId, name: { in: [...new Set([...wanted.values()].map((w) => w.table))] } }, select: { name: true, schemaJson: true } });
  const out: Record<string, RateParts> = {};
  for (const [key, w] of wanted) {
    const numeric = parseSchemaJson(lake.find((t) => t.name === w.table)?.schemaJson).filter((c) => c.type === "number").map((c) => c.name);
    const source = report.dataSources.find((d) => d.sql && tablesRead(d.sql).includes(w.table));
    if (!source || !numeric.includes(w.column)) continue;
    // One column over one column first; a numerator of two columns added only when none of those fits.
    for (const plus of [false, true]) {
      const probe = rateProbeSql(w.table, w.column, numeric, plus);
      if (probe.pairs.length === 0) continue;
      const q = { id: "q_probe_rate", name: "rate parts", dataSourceId: source.dataSourceId, sql: probe.sql } as Report["dataSources"][number];
      const scratch: Dataset = {};
      const errors: Record<string, string> = {};
      await runOne({ ...report, dataSources: [q] }, q.id, scratch, errors, { ...args, onQuery: undefined });
      const parts = errors[q.id] ? null : pickRateParts((scratch[q.id]?.[0] ?? {}) as Record<string, unknown>, probe.pairs);
      if (parts) { out[key] = parts; break; }
    }
  }
  return out;
}

/** The fixes reportRules.ts can name on its own: a promised count, a chart's height. */
async function applyCodeFixes(
  report: Report, dataset: Dataset, queryErrors: Record<string, string>, args: RunArgs, changes: Change[],
  text: { caption?: string; subtitle?: string; tableColumns?: Record<string, string[]>; kpiAsks?: KpiAsk[]; rateParts?: Record<string, RateParts>; locale?: string },
  drillsChecked: Map<string, boolean> = new Map(),
): Promise<Report> {
  text = { ...text, rateParts: await probeRateParts(report, dataset, text, args) };
  // Limits first: a chart's height follows the rows it ends up with.
  for (const v of detectViolations(report, dataset, text)) {
    const block = findBlock(report, v.target);
    if (v.fix?.kind !== "limit" || !block) continue;
    // A list on a report people already read is flagged (R23), not cut; the verifier's repair cuts it on purpose (autofix limit-rows).
    if (v.rule === "R23" && args.existing) continue;
    await limitQuery(report, v.fix.queryId, v.fix.n, dataset, queryErrors, args);
    changes.push({ kind: "limited", rule: v.rule, title: blockTitle(block), n: v.fix.n });
  }
  for (const v of detectViolations(report, dataset, text)) {
    const block = findBlock(report, v.target);
    if (v.fix?.kind !== "height" || !block) continue;
    report = resizeBlock(report, block.id, v.fix.h);
    changes.push({ kind: "resized", rule: "R6", title: blockTitle(block) });
  }
  // R29: words in the wrong script — a translation with a leak goes (the reader sees the report's own words), a minority run in
  // the report's own words is taken out. On a report people already read it is flagged instead.
  if (!args.existing) {
    for (const v of detectViolations(report, dataset, text)) {
      if (v.fix?.kind !== "script") continue;
      const done = applyScriptFix(report, v.fix);
      if (!done) continue;
      report = done.report;
      changes.push({ kind: "adjusted", rule: "R29", title: done.title });
    }
  }
  // The other mechanical repairs (R12-R18): a plan from the label, a readable field, time order, digits, a KPI's drill-down.
  // (A drill the code wrote and found empty is not written again.)
  const rest = detectViolations(report, dataset, text).filter((v) => v.fix && v.fix.kind !== "limit" && v.fix.kind !== "height" && v.fix.kind !== "script" && !(v.fix.kind === "drill-new" && drillsChecked.get(v.fix.queryId) === false));
  if (rest.length > 0) {
    report = structuredClone(report);
    for (const v of rest) {
      // A card on a report people already read is flagged, not taken away; the verifier's repair drops a repeat on purpose.
      if (v.rule === "R24" && args.existing) continue;
      // The same for a number: a figure people already read changes only when the verifier's repair says so.
      if (v.rule === "R26" && args.existing && !args.repair) continue;
      // A year moved back because it had no data (year-literal with relabel) is kept only if the card then shows a number.
      const fallback = v.fix!.kind === "year-literal" && v.fix.relabel
        ? { report: structuredClone(report), rows: structuredClone(dataset[v.fix.queryId] ?? []), error: queryErrors[v.fix.queryId] }
        : null;
      const done = applyRuleFix(report, v.fix as NumberRuleFix, dataset);
      if (!done) continue;
      changes.push({ kind: "adjusted", rule: v.rule, title: done.title });
      // A re-sorted query returns its rows in a new order: the checks after this read them.
      if (v.fix!.kind === "order" || v.fix!.kind === "weighted-ratio" || v.fix!.kind === "year-literal") await runOne(report, (v.fix as { queryId: string }).queryId, dataset, queryErrors, { ...args, onQuery: undefined });
      if (fallback && v.fix!.kind === "year-literal") {
        const qid = v.fix.queryId, cfg: any = findBlock(report, v.fix.blockId)?.config;
        const shown = cfg ? computeKpiValue({ valueField: cfg.valueField, aggregate: cfg.aggregate }, (dataset[qid] ?? []) as any) : NaN;
        if (!Number.isFinite(shown)) {
          // The year before has no number either: the card goes back as it was (and is dealt with as an empty card).
          report = fallback.report;
          dataset[qid] = fallback.rows;
          if (fallback.error) queryErrors[qid] = fallback.error; else delete queryErrors[qid];
          changes.pop();
        }
      }
    }
  }
  return dropDeadDrills(report, dataset, queryErrors, args, drillsChecked);
}

/** A drill-down whose query the code wrote (q_drill_*) must return rows as the reader: one that fails or opens nothing is taken off its block. */
async function dropDeadDrills(report: Report, dataset: Dataset, queryErrors: Record<string, string>, args: RunArgs, checked: Map<string, boolean>): Promise<Report> {
  const ids = new Set<string>();
  for (const b of report.pages.flatMap((p) => p.blocks)) {
    const q = (b.config as any)?.drilldown?.queryId;
    if (typeof q === "string" && q.startsWith("q_drill_") && checked.get(q) !== true && checked.get(q) !== false) ids.add(q);
  }
  if (ids.size === 0) return report;
  const next = structuredClone(report);
  for (const q of ids) {
    // Run with no blocks, as the drill route does: the runner skips a query only drills read when blocks exist.
    await runOne({ ...next, pages: [] }, q, dataset, queryErrors, { ...args, onQuery: undefined });
    const alive = !queryErrors[q] && (dataset[q]?.length ?? 0) > 0;
    checked.set(q, alive);
    if (alive) continue;
    delete queryErrors[q];
    delete dataset[q];
    for (const b of next.pages.flatMap((p) => p.blocks)) if ((b.config as any)?.drilldown?.queryId === q) delete (b.config as any).drilldown;
    next.dataSources = next.dataSources.filter((d) => d.id !== q);
  }
  return next;
}

// ── Layout ─────────────────────────────────────────────────────────────

type Block = Report["pages"][number]["blocks"][number];

function findBlock(report: Report, id: string): Block | null {
  for (const p of report.pages) { const b = p.blocks.find((x) => x.id === id); if (b) return b; }
  return null;
}

function usersOf(report: Report, queryId: string): number {
  return report.pages.flatMap((p) => p.blocks).filter((b) => queryIdOf(b) === queryId).length;
}

function titleFor(report: Report, v: Violation): string {
  const b = findBlock(report, v.target);
  return b ? blockTitle(b) : v.target;
}

/** Drop blocks, the queries only they used, and the grid rows they leave empty. */
export function removeBlocks(report: Report, ids: string[]): Report {
  const gone = new Set(ids);
  const pages = report.pages.map((p) => ({ ...p, blocks: compactRows(p.blocks.filter((b) => !gone.has(b.id))) }));
  // Every query a kept block reads — its own, a sparkline's, map pins', a drill's — and what those join.
  const used = neededQueries(report.dataSources, pages);
  return { ...report, pages, dataSources: report.dataSources.filter((d) => used.has(d.id)) };
}

function titleSubtitle(report: Report): string | undefined {
  const t = report.pages[0]?.blocks.find((b) => b.type === "title");
  return (t?.config as any)?.subtitle || undefined;
}

function setSubtitle(report: Report, subtitle: string | undefined): Report {
  return {
    ...report,
    pages: report.pages.map((p) => ({
      ...p,
      blocks: p.blocks.map((b) => (b.type === "title" ? { ...b, config: { ...(b.config as any), subtitle } } as Block : b)),
    })),
  };
}

function replaceCaption(report: Report, from: string, to: string): Report {
  return {
    ...report,
    pages: report.pages.map((p) => ({
      ...p,
      blocks: p.blocks.map((b) => (b.type === "text" && (b.config as any)?.text === from ? { ...b, config: { ...(b.config as any), text: to } } as Block : b)),
    })),
  };
}

function removeCaption(report: Report, caption: string | undefined): Report {
  if (!caption) return report;
  const ids = report.pages.flatMap((p) => p.blocks).filter((b) => b.type === "text" && (b.config as any)?.text === caption).map((b) => b.id);
  return ids.length ? removeBlocks(report, ids) : report;
}
