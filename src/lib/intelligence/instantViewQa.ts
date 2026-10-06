/**
 * Quality pass on a generated instant view, run by the generate route
 * after every query has resolved and before the draft is handed to the
 * client. Four checks, cheapest first:
 *
 *   1. the definition validates (ReportSchema) — a malformed draft never
 *      reaches the renderer or the Keep route;
 *   2. every block has data — blocks whose query errored or returned no
 *      rows are REMOVED from the draft (and named), rather than shown as
 *      an empty tile the person has to notice;
 *   3. numbers look sane — a percent-shaped field outside 0–100, a KPI
 *      that resolved to nothing, or a currency-formatted field whose own
 *      column name hints at a different currency than the workspace's
 *      (e.g. loans_thb_m rendered as $ under a USD tenant);
 *   4. the view answers the request — one short call to the fast model
 *      with the request, the surviving block titles, the result rows and
 *      the caption, asking for pass/warn and up to three notes. The
 *      blueprint wrote its caption from a handful of SAMPLE rows before
 *      any query ran, so a ranking or figure in it can be wrong once the
 *      real rows exist; the reviewer sees both and returns a corrected
 *      caption, which replaces the draft's. Skipped (warn, not fail) when
 *      no model is configured or the call fails. The review's own `notes`
 *      are written in the reader's UI locale; a rewritten caption matches
 *      whatever language the blueprint's caption was already written in.
 *
 * The verdict gates Keep: "fail" (nothing usable) disables it; "warn"
 * shows the notes and lets the person decide; "pass" is quiet.
 *
 * Every generated report reaches this through reportGate.ts, which also
 * hands the review what reportRules.ts's code checks flagged: the reviewer
 * may answer each with one of a few fixes the gate applies itself
 * (retitle, limit, remove) or confirm it with a reason — never SQL.
 */
import { ReportSchema, type Report } from "@/lib/reporting/schema";
import { callLLM } from "@/lib/llm";
import { DEFAULT_CURRENCY } from "@/lib/reporting/currency";
import { blockTitle as titleOf, queryIdOf, rulesForPrompt, REPORT_RULES, type RuleId, type Violation } from "./reportRules";

/** The rule ids a reviewer may confirm — every rule there is, R10 and on included. */
const RULE_IDS = new Set<string>(REPORT_RULES.map((r) => r.id));

export type QaCheck = { id: "schema" | "data" | "numbers" | "fit"; label: string; status: "pass" | "warn" | "fail"; detail?: string };

/** A fix the reviewer may ask for. The gate applies it; the reviewer never edits the report itself. */
export type ReviewOp =
  | { op: "retitle"; target: string; text: string }
  | { op: "limit"; target: string; n: number }
  | { op: "remove"; target: string; reason: string };
export type ReviewConfirm = { target: string; rule: RuleId; reason: string };

export type QaResult = {
  verdict: "pass" | "warn" | "fail";
  checks: QaCheck[];
  report: Report;
  removed: Array<{ id: string; title: string; reason: string }>;
  /** Blocks with no data that were kept (keepEmptyBlocks) — flagged instead of removed. */
  empty: Array<{ id: string; title: string; reason: string }>;
  /** The caption and subtitle as they stand after review. */
  caption?: string;
  subtitle?: string;
  review: { ran: boolean; ops: ReviewOp[]; confirmed: ReviewConfirm[]; notes: string[] };
};

type Row = Record<string, unknown>;

export async function qaInstantView(args: {
  report: Report;
  dataset: Record<string, Row[]>;
  queryErrors: Record<string, string>;
  prompt: string;
  /** What reportRules.ts's code checks flagged — the reviewer answers each one. */
  violations?: Violation[];
  /** A report already saved and read, being re-checked: a block with no data right now is flagged, not removed. */
  keepEmptyBlocks?: boolean;
  /** The blueprint's caption text, so the reviewer can check it against the rows and the fix can find its block. */
  caption?: string;
  /** The blueprint's title-block subtitle, so the reviewer can check it too — it's written from sample rows the same way the caption is, and is just as liable to state a wrong total once the real rows exist. */
  subtitle?: string;
  /** The reader's UI locale — the review's own `notes` are written in this
   *  language (same rule Ask uses); a rewritten caption instead matches
   *  whatever language the blueprint's own caption was already in. */
  locale?: "en" | "th" | "zh";
  /** This workspace's currency (Tenant.currency, ISO 4217) — the numbers
   *  check flags a currency-formatted field whose own NAME hints at a
   *  different currency (e.g. loans_thb_m rendered under a USD workspace).
   *  Null/undefined defaults to DEFAULT_CURRENCY, matching Tenant.currency's own
   *  fallback (see the schema comment). */
  tenantCurrency?: string | null;
  tenantId: string | null;
  userId?: string | null;
  signal?: AbortSignal;
}): Promise<QaResult> {
  const checks: QaCheck[] = [];
  const removed: QaResult["removed"] = [];
  const empty: QaResult["empty"] = [];

  // 1. Schema
  const parsed = ReportSchema.safeParse(args.report);
  if (!parsed.success) {
    checks.push({ id: "schema", label: "Definition validates", status: "fail", detail: parsed.error.issues[0]?.message ?? "invalid" });
    return { verdict: "fail", checks, report: args.report, removed, empty, caption: args.caption, subtitle: args.subtitle, review: NO_REVIEW };
  }
  checks.push({ id: "schema", label: "Definition validates", status: "pass" });
  let report: Report = parsed.data;

  // 2. Data per block
  const page = report.pages[0];
  const blocks = page?.blocks ?? [];
  const keep = blocks.filter((b) => {
    const queryId = queryIdOf(b);
    if (!queryId) return true; // title/text/divider — nothing to check
    const err = args.queryErrors[queryId];
    const rows = args.dataset[queryId] ?? [];
    const reason = err ? `its query failed — ${err}` : rows.length === 0 ? "its query returned no rows" : null;
    if (!reason) return true;
    (args.keepEmptyBlocks ? empty : removed).push({ id: b.id, title: titleOf(b), reason });
    return !!args.keepEmptyBlocks;
  });
  const dataBlocks = keep.filter((b) => !!queryIdOf(b) && !empty.some((e) => e.id === b.id));
  if (dataBlocks.length === 0) {
    checks.push({ id: "data", label: "Every block has data", status: "fail", detail: removed.length ? `${removed.length} block(s) had no data` : "no data blocks in the draft" });
    return { verdict: "fail", checks, report, removed, empty, caption: args.caption, subtitle: args.subtitle, review: NO_REVIEW };
  }
  if (removed.length > 0) {
    const usedQueries = new Set(keep.map(queryIdOf).filter(Boolean));
    report = {
      ...report,
      pages: [{ ...page!, blocks: keep }, ...report.pages.slice(1)],
      dataSources: report.dataSources.filter((d) => usedQueries.has(d.id)),
    };
    checks.push({ id: "data", label: "Every block has data", status: "warn", detail: `removed ${removed.map((r) => `“${r.title}”`).join(", ")}` });
  } else if (empty.length > 0) {
    checks.push({ id: "data", label: "Every block has data", status: "warn", detail: `no data now in ${empty.map((e) => `“${e.title}”`).join(", ")}` });
  } else {
    checks.push({ id: "data", label: "Every block has data", status: "pass" });
  }

  // 3. Numbers
  const oddities: string[] = [];
  const tenantCurrency = (args.tenantCurrency || DEFAULT_CURRENCY).toUpperCase();
  for (const b of dataBlocks) {
    const rows = args.dataset[queryIdOf(b)!] ?? [];
    const cfg = (b as any).config ?? {};
    const isCurrencyBlock = cfg.format === "currency" || cfg.valueFormat === "currency";
    const fields: string[] = [cfg.valueField, ...(Array.isArray(cfg.yFields) ? cfg.yFields : []), cfg.yField].filter((f): f is string => typeof f === "string");
    for (const f of fields) {
      const vals = rows.map((r) => r[f]).filter((v) => v !== null && v !== undefined);
      if (vals.length === 0) { oddities.push(`“${titleOf(b)}” — ${f} is empty`); continue; }
      const nums = vals.map(Number).filter((n) => Number.isFinite(n));
      if (nums.length === 0) { oddities.push(`“${titleOf(b)}” — ${f} isn't numeric`); continue; }
      if (/pct|percent|ratio|rate/i.test(f) || cfg.format === "percent") {
        const max = Math.max(...nums), min = Math.min(...nums);
        if (max > 100 || min < 0) oddities.push(`“${titleOf(b)}” — ${f} runs ${min.toFixed(0)}–${max.toFixed(0)}, outside 0–100`);
      }
      // A currency-formatted block whose own column name names a DIFFERENT
      // currency than the workspace's — e.g. a "loans_thb_m" column
      // rendered with the $ formatter under a USD tenant. The formatter has
      // no way to know the data is really THB; the column name is the only
      // signal, so this is advisory (warn), not proof.
      if (isCurrencyBlock) {
        const hint = currencyHintFromColumnName(f);
        if (hint && hint !== tenantCurrency) {
          oddities.push(`“${titleOf(b)}” — ${f} looks like ${hint} but this workspace's currency is ${tenantCurrency}`);
        }
      }
    }
  }
  checks.push(oddities.length > 0
    ? { id: "numbers", label: "Numbers look sane", status: "warn", detail: oddities.slice(0, 3).join("; ") }
    : { id: "numbers", label: "Numbers look sane", status: "pass" });

  // 4. Fit to the request (fast model, short)
  // Flags on a block the data check just removed are moot.
  const live = new Set(keep.map((b) => b.id));
  const violations = (args.violations ?? []).filter((v) => live.has(v.target) || v.target === "caption" || v.target === "subtitle");
  const fit = await fitReview({ report, dataset: args.dataset, prompt: args.prompt, caption: args.caption, subtitle: args.subtitle, violations, locale: args.locale, tenantId: args.tenantId, userId: args.userId, signal: args.signal });
  checks.push(fit.check);
  if (fit.caption && args.caption) report = replaceCaption(report, args.caption, fit.caption);
  if (fit.subtitle && args.subtitle) report = replaceSubtitle(report, args.subtitle, fit.subtitle);

  const verdict: QaResult["verdict"] = checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "warn") ? "warn" : "pass";
  return {
    verdict, checks, report, removed, empty,
    caption: args.caption ? fit.caption ?? args.caption : undefined,
    subtitle: args.subtitle ? fit.subtitle ?? args.subtitle : undefined,
    review: fit.review,
  };
}

const NO_REVIEW: QaResult["review"] = { ran: false, ops: [], confirmed: [], notes: [] };

/** Rows the reviewer sees per block — enough to check a ranking or a total, small enough to stay a fast call. */
const REVIEW_ROWS = 12;

/** Same instruction Ask gives the model (askChat.ts's answerLanguageRule) — kept as a sibling copy rather than an import because this prompt applies it to ONE field of a JSON reply (`notes`), not the whole response. */
function notesLanguageRule(locale?: "en" | "th" | "zh"): string {
  if (locale === "th") return "Write \"notes\" in Thai (ภาษาไทย) — the reader's interface is Thai.";
  if (locale === "zh") return "Write \"notes\" in Simplified Chinese — the reader's interface is Chinese.";
  return "Write \"notes\" in English.";
}

async function fitReview(args: { report: Report; dataset: Record<string, Row[]>; prompt: string; caption?: string; subtitle?: string; violations: Violation[]; locale?: "en" | "th" | "zh"; tenantId: string | null; userId?: string | null; signal?: AbortSignal }): Promise<{ check: QaCheck; caption?: string; subtitle?: string; review: QaResult["review"] }> {
  const blocks = (args.report.pages[0]?.blocks ?? []).filter((b) => !!queryIdOf(b));
  const sqlById = new Map(args.report.dataSources.map((d) => [d.id, d.sql ?? ""]));
  // Each block with its id (what a fix names), its query (what the words
  // must describe) and its size (whether it can be read).
  const digest = blocks.map((b) => {
    const rows = args.dataset[queryIdOf(b)!] ?? [];
    const sample = rows.slice(0, REVIEW_ROWS).map((r) => JSON.stringify(r)).join(" | ");
    const sql = (sqlById.get(queryIdOf(b)!) ?? "").replace(/\s+/g, " ").slice(0, 400);
    return `- [${b.id}] ${b.type} “${titleOf(b)}” (${b.w}×${b.h} grid, ${rows.length} rows)\n  SQL: ${sql}\n  Rows: ${sample}${rows.length > REVIEW_ROWS ? " …" : ""}`;
  }).join("\n");
  const flagged = args.violations.map((v) => `- ${v.rule} on ${v.target}: ${v.detail}`).join("\n");
  const skipped = (detail: string) => ({
    check: { id: "fit", label: "Answers the request", status: "warn", detail } as QaCheck,
    review: { ran: false, ops: [], confirmed: [], notes: [] },
  });
  const resp = await callLLM({
    tenantId: args.tenantId,
    userId: args.userId ?? null,
    kind: "qa.instant_view",
    system: [
      "You review a generated analytics report before anyone sees it, against the request that produced it and these rules:",
      ...rulesForPrompt(),
      "Judge: does the report answer the request with what it shows, and does every title and label say exactly what its query computes (the SQL is given)?",
      "The caption and the title's subtitle were both written before the queries ran, from a few sample rows — a figure, percentage, or ranking stated in either one can be wrong once the real (often much larger) rows exist. Check every figure and ranking each one states against the rows given; if either is wrong, rewrite it as one sentence grounded ONLY in those rows, in the SAME language the original text was written in. If a field is accurate (or wasn't provided), return null for it.",
      "Code checks flagged the items listed under \"Flagged\". Answer EACH one: either a fix — \"retitle\" (new words that say exactly what the query computes, same language as the original), \"limit\" (a chart's row count, 1-50; retitle it too if its title names a count), or \"remove\" (when no honest wording fits) — or a \"confirm\" with a one-sentence reason when the flag is a false alarm. You may also fix anything else that breaks a rule. Never write SQL.",
      "Retitle only when the words are wrong. Titles are for business readers: keep the SAME language as the original title, and add no SQL words (SUM, AVG, MAX, COUNT, NULL) and no column or table names the original didn't have. Remove a block only when its words can't honestly describe its numbers — not because it is plain or off-topic; say that in a note instead. Use \"limit\" only to cut a chart to the count its title promises, or to make a crowded chart readable (then name the count in its title).",
      "When a column's meaning is ambiguous, say how the report reads it in a note.",
      notesLanguageRule(args.locale),
      "Reply with ONLY a JSON object: { \"verdict\": \"pass\" | \"warn\", \"notes\": [\"...\"], \"caption\": \"...\" | null, \"subtitle\": \"...\" | null, \"fixes\": [{ \"target\": \"<block id>\", \"op\": \"retitle\", \"text\": \"...\" } | { \"target\": \"<block id>\", \"op\": \"limit\", \"n\": 10 } | { \"target\": \"<block id>\", \"op\": \"remove\", \"reason\": \"...\" }], \"confirm\": [{ \"target\": \"<block id>\", \"rule\": \"R2\", \"reason\": \"...\" }] } — at most 3 notes, each one short sentence, empty when it passes cleanly. A rewritten caption or subtitle is not by itself a warn.",
    ].join("\n"),
    messages: [{ role: "user", content: `Request: ${args.prompt}\n\nReport “${args.report.name}”:\n${digest}\n\nSubtitle: ${args.subtitle ?? "(none)"}\n\nCaption: ${args.caption ?? "(none)"}\n\nFlagged:\n${flagged || "(nothing)"}` }],
    maxTokens: 1200,
    temperature: 0.2,
    responseFormat: "json",
    signal: args.signal,
  } as any);
  if (resp.status !== "ok" || !resp.text?.trim()) return skipped("review skipped — the model didn't respond");
  try {
    const text = resp.text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/, "$1");
    const obj = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const notes: string[] = Array.isArray(obj?.notes) ? obj.notes.filter((n: unknown) => typeof n === "string").slice(0, 3) : [];
    const caption = typeof obj?.caption === "string" && obj.caption.trim() && obj.caption.trim() !== (args.caption ?? "").trim() ? obj.caption.trim() : undefined;
    const subtitle = typeof obj?.subtitle === "string" && obj.subtitle.trim() && obj.subtitle.trim() !== (args.subtitle ?? "").trim() ? obj.subtitle.trim() : undefined;
    const ids = new Set(blocks.map((b) => b.id));
    const ops = (Array.isArray(obj?.fixes) ? obj.fixes : []).map(parseOp).filter((o: ReviewOp | null): o is ReviewOp => !!o && ids.has(o.target));
    const confirmed: ReviewConfirm[] = (Array.isArray(obj?.confirm) ? obj.confirm : [])
      .filter((c: any) => ids.has(c?.target) && RULE_IDS.has(c?.rule) && typeof c?.reason === "string" && c.reason.trim())
      .map((c: any) => ({ target: c.target, rule: c.rule, reason: c.reason.trim().slice(0, 200) }));
    const status: QaCheck["status"] = obj?.verdict === "pass" && notes.length === 0 ? "pass" : "warn";
    const detail = [...notes, ...(caption ? ["caption rewritten from the actual results"] : []), ...(subtitle ? ["subtitle rewritten from the actual results"] : [])].join(" ") || undefined;
    return { check: { id: "fit", label: "Answers the request", status, detail }, caption, subtitle, review: { ran: true, ops, confirmed, notes } };
  } catch {
    return skipped("review skipped — unreadable reply");
  }
}

/** One fix from the reviewer, or null when it isn't one of the three the gate applies. */
function parseOp(o: any): ReviewOp | null {
  if (!o || typeof o.target !== "string") return null;
  if (o.op === "retitle" && typeof o.text === "string" && o.text.trim()) return { op: "retitle", target: o.target, text: o.text.trim().slice(0, 160) };
  if (o.op === "limit" && Number.isInteger(o.n) && o.n >= 1 && o.n <= 50) return { op: "limit", target: o.target, n: o.n };
  if (o.op === "remove") return { op: "remove", target: o.target, reason: typeof o.reason === "string" ? o.reason.trim().slice(0, 200) : "" };
  return null;
}

function replaceCaption(report: Report, from: string, to: string): Report {
  return {
    ...report,
    pages: report.pages.map((page) => ({
      ...page,
      blocks: page.blocks.map((b) => (b.type === "text" && (b.config as any).text === from ? { ...b, config: { ...(b.config as any), text: to } } as typeof b : b)),
    })),
  };
}

function replaceSubtitle(report: Report, from: string, to: string): Report {
  return {
    ...report,
    pages: report.pages.map((page) => ({
      ...page,
      blocks: page.blocks.map((b) => (b.type === "title" && (b.config as any).subtitle === from ? { ...b, config: { ...(b.config as any), subtitle: to } } as typeof b : b)),
    })),
  };
}

/** Currency a column's own name names, if any — e.g. "loans_thb_m" → THB. Whole-token match only, so "customer" never hints EUR off "eur" appearing mid-word. */
const CURRENCY_NAME_HINTS: Record<string, string> = { thb: "THB", baht: "THB", usd: "USD", dollar: "USD", dollars: "USD", eur: "EUR", euro: "EUR" };

function currencyHintFromColumnName(name: string): string | null {
  for (const token of name.toLowerCase().split(/[^a-z]+/)) {
    const hint = CURRENCY_NAME_HINTS[token];
    if (hint) return hint;
  }
  return null;
}
