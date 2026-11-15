/**
 * The rules a generated report must meet before anyone sees it — the one
 * place they are written down.
 *
 * Each rule is three things kept together so they can't drift apart:
 *   - `ai`: the sentence the models are given, when they design a report
 *     (autoCurf.ts's prompts) and when they review one (reportGate.ts);
 *   - `check`: what code verifies, in `detectViolations` below — a prompt
 *     is advice, this is the enforcement (CLAUDE.md, "Security first");
 *   - `onFail`: what the gate does when the check still fails after review.
 * docs/REPORT_QUALITY_RULES.md is generated from this list
 * (`npm run report-rules:doc`), and a test fails when it is stale.
 *
 * Pure: no server imports. The gate uses it, so do the generation prompts,
 * the read-only scan of existing reports (scripts/report-rules/scan.ts,
 * bundled to run inside the pod) and the viewer's quality note.
 */
import type { KpiAsk } from "./kpiMatch";
import type { Report } from "@/lib/reporting/schema";
import { formatCell } from "@/lib/reporting/format";
import { detectNumberRules, type NumberRuleFix, type RateParts } from "./reportRulesNumbers";
import { absurdPercents, cleanScript, scriptLeaks } from "./narrativeChecks";

export { applyRuleFix, targetFromLabel, type NumberRuleFix, type RateParts } from "./reportRulesNumbers";

export type RuleId = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8" | "R9" | "R10" | "R11" | "R12" | "R13" | "R14" | "R15" | "R16" | "R17" | "R18" | "R19" | "R20" | "R21" | "R22" | "R23" | "R24" | "R25" | "R26" | "R27" | "R28" | "R29" | "R30" | "R31" | "R32" | "R33" | "R34" | "R35";

export type ReportRule = {
  id: RuleId;
  title: string;
  /** Given to the models that design and review a report. */
  ai: string;
  /** Who enforces it: code alone, code that the reviewer may resolve, or the reviewer alone. */
  enforcement: "code" | "code+ai" | "ai";
  /** What code checks, in words — for the doc. */
  check: string;
  /** What happens to a report that still breaks the rule after review. */
  onFail: string;
  /**
   * Where the rule applies: a report (the default — the gate, the design and
   * review prompts), or the narrative written for executives around reports
   * (the Brief's stories, an app's headline and goals: lib/brief.ts), or both.
   */
  surfaces?: Array<"report" | "executive">;
};

export const REPORT_RULES: ReportRule[] = [
  {
    id: "R1",
    title: "A title that promises a count shows exactly that many",
    ai: "A chart or table titled \"Top N\" (or \"N อันดับ\", \"前N\") shows exactly N rows — set its \"limit\" to N.",
    enforcement: "code",
    check: "The title's N is read from the text; a query that returns more rows than that is limited to N and run again.",
    onFail: "Fixed automatically — the query is limited to N.",
  },
  {
    id: "R2",
    title: "A label that names a condition is computed with that condition",
    ai: "If a KPI label or chart title names a condition (never sold, only branch X, where a date is empty, excluding returns), its query must apply it — give a KPI a \"where\" filter. Never put a condition only in the words.",
    enforcement: "code+ai",
    check: "A label or title with condition words (null, never, only, without, ไม่เคย, ยังไม่, เฉพาะ, 未, 仅…) whose SQL has no WHERE or CASE WHEN is flagged; the reviewer must fix the words, remove the block, or confirm it with a reason.",
    onFail: "An AI-written block is removed; a hand-written template's is kept with a note.",
  },
  {
    id: "R3",
    title: "A label's calculation word matches the calculation",
    ai: "A KPI labelled average / highest / lowest / total must use avg / max / min / sum (or count) — the words say what the number is. A KPI that is a period (\"Latest fiscal year\", \"ปีงบประมาณล่าสุด\") shows the period itself (max of the column), never a count of rows.",
    enforcement: "code+ai",
    check: "The KPI's aggregate is read from its SQL (SUM, AVG, MIN, MAX, COUNT) and compared with the label's words in English, Thai and Chinese; a label that is only a period (latest fiscal year, เดือนล่าสุด, 本月) allows MIN or MAX only.",
    onFail: "An AI-written block is removed; a hand-written template's is kept with a note.",
  },
  {
    id: "R4",
    title: "Every figure in a caption or subtitle comes from the report's own results",
    ai: "The caption and subtitle are rewritten after the queries run; every number in them must be a value, total, share or change readable from those results — never from sample rows.",
    enforcement: "code+ai",
    check: "Each number in the text is matched against the results (values, row counts, column totals and averages, shares of a total, changes between two values), allowing for the precision it was written with; years, small counts and numbers in the report's own titles pass. Text that says it describes the sample (\"from the sample\", \"จากตัวอย่าง\") fails outright.",
    onFail: "The reviewer rewrites it; if a figure still isn't in the results the caption or subtitle is left out. Applies to text a model wrote — a template's copy comes from the data itself.",
  },
  {
    id: "R5",
    title: "No empty or broken blocks",
    ai: "Only propose blocks the data can fill.",
    enforcement: "code",
    check: "Every query runs as the member building the report; a block whose query fails or returns no rows is flagged.",
    onFail: "The block is removed and named in the report's quality note.",
  },
  {
    id: "R6",
    title: "A chart can be read at its size",
    ai: "Rank at most 15 categories unless asked for more; use a horizontal bar for long category names.",
    enforcement: "code+ai",
    check: "A horizontal bar, a grid heatmap and a table get the height their rows need (a full-width heatmap or table that is taller than that is shortened); a table's is worked out the way the viewer lays it out — each column its browser width, each cell's text wrapped into it, in the widest language the block carries — and a list of more than 30 rows scrolls in its card; a bar with more rows than fit even at the tallest size, or a pie with more than 8 slices, is flagged for the reviewer to limit.",
    onFail: "Height is fixed automatically; a chart still too dense is kept with a note.",
  },
  {
    id: "R7",
    title: "Numbers are formatted as what they are",
    ai: "Use \"percent\" only for rates and \"currency\" only for money.",
    enforcement: "code",
    check: "Percent fields outside 0–100 and currency fields whose column name names another currency are flagged (instantViewQa.ts).",
    onFail: "Kept with a note.",
  },
  {
    id: "R8",
    title: "Nothing is made up",
    ai: "Use only the tables given. If the question needs data they don't have, leave that out and say what is missing in the caveat.",
    enforcement: "code",
    check: "Master Builder only reads tables that exist (appliers/table.ts refuses a missing \"existing\" table; tenantTables.ts stops a synthetic copy of a real one); every block's query is run against real data before saving.",
    onFail: "The table or report fails with the reason instead of being filled in.",
  },
  {
    id: "R9",
    title: "Uncertain meanings are said out loud",
    ai: "When a column's meaning is ambiguous (days in stock vs. days since the last sale), say how you read it.",
    enforcement: "ai",
    check: "Reviewer only — its notes are kept on the report.",
    onFail: "Shown to readers in the report's quality note.",
  },
  {
    id: "R10",
    title: "A balance is read at a point in time, never added up across periods",
    ai: "A balance or stock (closing balance, reserve at year end, stock on hand, headcount, outstanding) is a level, not a flow: show it for one period (the latest, or one per period on a trend) — never SUM it over several periods, which counts the same money again for every period.",
    enforcement: "code+ai",
    check: "A KPI or chart value that SUMs a column named like a balance (balance, closing, ending, opening, _end, _begin, on_hand, stock, inventory, headcount, outstanding, คงเหลือ, ยกมา, 余额, 库存, 期末, 期初), over a table that keeps a row per period (a column that is a period: month, year, fiscal_year, week, quarter, period, snapshot date), is flagged unless its query holds one period per value: GROUP BY a period column, a period filter (WHERE year = …), a CASE WHEN on a period, or ORDER BY a period with LIMIT 1. A snapshot — one row per loan or item, dated only by events like an origination date — sums its balances correctly and passes.",
    onFail: "An AI-written block is removed; a hand-written template's is kept with a note.",
  },
  {
    id: "R11",
    title: "A KPI shows one measure, and its label names one",
    ai: "A KPI label names the one number the KPI shows. \"Average rate and total budget\" is two numbers — make two KPIs.",
    enforcement: "code+ai",
    check: "A KPI label that names two different calculations (average and total, highest and lowest — in English, Thai and Chinese) is flagged; it can only show one of them.",
    onFail: "An AI-written block is removed; a hand-written template's is kept with a note.",
  },
  {
    id: "R12",
    title: "A target stated in a KPI's label is the KPI's plan",
    ai: "A KPI whose label states a target (\"target 85%\", \"เป้าหมาย ≤ 35%\") carries it as the KPI's \"plan\" (a rate as a fraction: 0.85) — set sparkPositive \"down\" when lower is better — so the card shows how far it is from plan.",
    enforcement: "code",
    check: "A KPI label with a target (target / เป้าหมาย / 目标, an optional ≥ ≤ at least / not exceeding, a number and %) whose KPI is a percent or a number and has neither plan nor planField. When the brief named the KPI with a target (kpiAsks, matched by name in any language: kpiMatch.ts), that target is its plan — a rate target only on a percent KPI, a plain one only on a number.",
    onFail: "Fixed automatically — the plan is set from the label or the brief (lower-is-better targets set sparkPositive down).",
  },
  {
    id: "R13",
    title: "A KPI reads its number from a field a person can read",
    ai: "Name every SQL output column in words (\"paid_baht\"), never with digits first (\"2569_100\", \"4_35\", \"8\"): the field name shows in popovers and exports.",
    enforcement: "code",
    check: "A KPI whose valueField starts with a digit; renamed to kpi_value when only that KPI reads the query.",
    onFail: "Fixed automatically where the query is the KPI's own; otherwise kept with a note.",
  },
  {
    id: "R14",
    title: "A time axis runs forward and a cumulative line never falls",
    ai: "A line or area chart over time ORDER BY its time key (a month number, a date), never by its measure; a cumulative series rises from the first period to the last.",
    enforcement: "code",
    check: "A line, area or combo chart over a time field whose query's first ORDER BY key is one of its measures, a time axis whose numbers run backwards, or a series named cumulative / สะสม / 累计 that falls over its rows. Fixed with the table's month/period order column (or the time field itself when it sorts).",
    onFail: "Fixed automatically when the query is the chart's own and a time key exists; otherwise kept with a note.",
  },
  {
    id: "R15",
    title: "A year in a label is the year the query filters to",
    ai: "A KPI label or chart title that names a fiscal year (FY2569, ปี 2569) must filter its query to that year (WHERE fiscal_year = 2569) — or say it spans several years.",
    enforcement: "code",
    check: "A title or label naming a year (FY, ปีงบประมาณ, ปี, 年度 + 20xx/25xx) without words like multiple years or trend, whose SQL holds neither that year nor a year parameter and does not group by the year column, while the table it reads has a year column (or its result spans several years).",
    onFail: "Kept with a note: the label may claim a scope the number does not have.",
  },
  {
    id: "R16",
    title: "A share stays between 0 and 100%",
    ai: "A KPI labelled share, ratio, rate or สัดส่วน is a fraction of a whole: never above 100% or below 0 — recheck its numerator and denominator.",
    enforcement: "code",
    check: "A percent KPI with a share/ratio/rate label (and no growth or change word) whose single value is above 105% or below 0.",
    onFail: "Kept with a note.",
  },
  {
    id: "R17",
    title: "A column of numbers shows sensible digits",
    ai: "Give every numeric table column a type (\"number\" with a digit count, \"percent\", \"currency\"): never print 192.2973.",
    enforcement: "code",
    check: "A table column with no digit count whose values are numbers with more than two decimals.",
    onFail: "Fixed automatically — the column becomes a number with 0-2 decimals (a 0-1 rate named pct/share/ratio becomes a percent).",
  },
  {
    id: "R18",
    title: "A KPI opens the rows behind it",
    ai: "Give a KPI a \"drilldown\" to the rows behind its number: the report's own detail table when it lists them, else a query of its own over the same table with the same conditions (no aggregate).",
    enforcement: "code",
    check: "A KPI with no drilldown. The report's table that reads the same tables, keeps rows by at least the KPI's conditions, is not grouped or a top-N list under 100 rows and binds only the report's parameters; with none, the KPI's own query without its aggregate (guard CTEs kept, the value's CASE WHEN conditions as the WHERE).",
    onFail: "Fixed automatically — the drilldown points at that table's query, or at a new query written from the KPI's SQL and checked to return rows.",
  },
  {
    id: "R19",
    title: "A percent or a gauge shows a share, not an amount",
    ai: "A KPI or gauge shown as a percent holds a ratio (0.85 for 85%), never a raw amount: divide the numerator by the denominator in the query, and never leave a calculation (\"divided by 100\") in a label or title.",
    enforcement: "code",
    check: "A percent KPI whose value is above 1000%, a gauge or percent-formatted chart whose value is far beyond its maximum, a label or title that says it was divided or multiplied by something (divided by, ÷, หาร, 除以).",
    onFail: "Kept with a note; the repair brief names the amount and the columns a denominator could come from.",
  },
  {
    id: "R20",
    title: "A ratio covers the scope its label names",
    ai: "A ratio whose label names a scope (investment, operating spend, a year) limits both its numerator and its denominator to it. Say in the label what the figures are.",
    enforcement: "code",
    check: "A percent KPI whose label names investment / ลงทุน or operating spend while its query never mentions it (it divides, or reads a share already worked out in a column). The verifier also runs the numerator and the denominator separately and prints both.",
    onFail: "Kept with a note; the repair brief gives the numerator, the denominator and the scope the label asks for.",
  },
  {
    id: "R21",
    title: "A gap equals the actual minus the target beside it",
    ai: "A KPI that shows the gap to a target is the actual KPI's value minus the target — computed over the same rows and the same period as the actual, not averaged over months while the actual is the year-end figure.",
    enforcement: "code",
    check: "A KPI labelled gap / variance / ส่วนต่าง / เทียบเป้า with an actual KPI of the same query and unit and a target (a plan, a target in a label, or the constant the query subtracts) whose difference does not match the gap (beyond 1 point and 15%).",
    onFail: "Kept with a note: the two cards give two answers to one question.",
  },
  {
    id: "R22",
    title: "A series has a value in every row, and no value dwarfs the rest",
    ai: "A bar or line series shows a value (0 when there is none) for every category it lists; check a value ten times the median is real.",
    enforcement: "code",
    check: "A bar, line, area or combo chart with a series that is blank in some rows while others have a value (a bar missing among bars); a table column with blanks (a note for the verifier); a chart value more than 10 times the median and 3 times the next (a note for the verifier).",
    onFail: "Kept with a note for a missing bar; the rest is a note for the repair brief.",
  },
  {
    id: "R23",
    title: "A table on a card lists at most 25 rows",
    ai: "A table block is a short list (the top 10-20 rows, ORDER BY the measure, LIMIT 25 at most): never 50 or 100 rows that scroll inside a card. The rest is one click away in a KPI's drill-down.",
    enforcement: "code",
    check: "A table block whose query returns more than 25 rows (TABLE_CARD_MAX_ROWS) — at 41px a row, 50 rows are 3,000px of list inside a card.",
    onFail: "Fixed automatically — the query is limited to 25 rows, when only that table reads it, no drill-down opens it and its title does not promise more; otherwise flagged.",
  },
  {
    id: "R24",
    title: "One number sits on one card",
    ai: "A figure appears on one KPI card. Two cards that read the same value (same column, same aggregate, same filters) are one card said twice: keep the better-labelled one, with its target and drill-down.",
    enforcement: "code",
    check: "Two or more KPI blocks whose value is the same select item with the same aggregate and format over the same query text (a repeated query under another id counts).",
    onFail: "On a new report the repeat is dropped (its plan or drill-down moves to the card that stays), unless the brief named both or something else refers to it; on a saved report it is flagged and the verifier's repair drops it.",
  },
  {
    id: "R25",
    title: "A KPI's label says what its number is",
    ai: "A KPI's words and its number agree: an amount is never read from a count of rows, and a unit phrase in the label (in hundreds of baht, in millions) is there only when the query divides by it. Money is stored in baht and the card compacts it, so leave unit phrases out.",
    enforcement: "code",
    check: "A KPI label with a unit phrase (หน่วยร้อยบาท, in thousands, 万元) whose query divides by another scale (or none), or a governed metric (always baht); a KPI whose label names an amount (ยอดเงิน, บาท, budget) with no count word, over a COUNT or a count column.",
    onFail: "A unit phrase the number does not have is taken off the label (and its translations); an amount label over a count is flagged, and the verifier's recomputation and repair brief name the column that holds the amount.",
  },
  {
    id: "R26",
    title: "A rate is the sum of its parts, not an average of rates",
    ai: "A rate, share or percent over many rows is SUM(numerator) * 1.0 / NULLIF(SUM(denominator), 0) from the amounts it is made of. Never AVG a rate or percent column: rows of different size count equally in an average, so it is not the overall rate (an average collection rate of 75.7% where the true rate is 88.0%).",
    enforcement: "code",
    check: "A KPI whose value is an AVG over a rate-like column (name ends or starts _pct, _percent, _rate, _ratio, _share) on a percent or share card, not governed by a metric.",
    onFail: "On a new report the query is rewritten to the weighted ratio when the table holds the numerator and the denominator (found by testing which two columns reproduce the rate on every row); otherwise, and on a saved report, it is flagged and the verifier's repair brief names the rule.",
  },
  {
    id: "R27",
    title: "A KPI card shows a number",
    ai: "Every KPI card has a value: its query returns a row whose value field is a number. A figure the data cannot give (a filter that matches nothing, a column that is empty) is left off, not drawn as a dash.",
    enforcement: "code",
    check: "A KPI block whose query returns rows but whose value field is empty or not a number in them (the card would read a dash).",
    onFail: "On a new report the card is removed and named in the quality note (a KPI the brief asked for is then re-added by the build's completion when the data can answer it); on a saved report, or when something else refers to the card, it is flagged.",
  },
  {
    id: "R28",
    title: "A card labelled a rate shows a rate",
    ai: "A KPI whose label says rate, share or ratio shows a ratio: its query divides one amount by another (SUM(part) * 1.0 / NULLIF(SUM(whole), 0)) and the card is formatted as a percent. Never label a baht total or a count \"rate\", and never read the numerator of a rate off as the card's value.",
    enforcement: "code",
    check: "A KPI, not governed by a metric, whose label names a rate, share or ratio (not a change or growth), whose format is not percent, whose query contains no division, and whose value is money or above 100.",
    onFail: "On a new report the card is removed and named in the quality note (a KPI the brief asked for is then re-added by the build's completion from a governed metric or a model-written block that divides); on a saved report it is flagged and the verifier's repair brief names the rule.",
  },
  {
    id: "R29",
    title: "Text in a language is written in that language's script",
    ai: "Write each language in its own script: Thai text holds no Chinese characters, Chinese text no Thai, English neither. Names quoted from the data stay as they are.",
    enforcement: "code",
    check: "Every translation (a block's i18n, the report's nameI18n/descriptionI18n), and the report's own words in the language it was built in, is scanned for letters of another script than its language's own and Latin (Han or kana inside Thai, Thai inside Chinese, either inside English); a run that is part of a value in the results or a name on the report is a quote and passes (narrativeChecks.ts scriptLeaks). The Brief's stories and an app's goals get the same check against the reader's language.",
    onFail: "Fixed automatically: a translation with a leak is taken out, so the reader sees the report's own words; a leaked run in the report's own words is taken out when it is a minority of the text (a caption or subtitle that is mostly another script is left out); otherwise flagged. A goal or story shows another language's text, or nothing, instead.",
    surfaces: ["report", "executive"],
  },
  {
    id: "R30",
    title: "No percentage a reader can't believe",
    ai: "Never write a percentage beyond ±1000%, or a share of a whole (weight, contribution, \"of the total\") above 100%: those come from dividing by a near-zero base. Say the two values instead (\"from 0.3 to 43\").",
    enforcement: "code",
    check: "A percentage in a caption, subtitle or executive story beyond ±1000%, or above 100% next to a share word (weight, share, contribution, of the total, สัดส่วน, น้ำหนัก, 占比, 权重) — narrativeChecks.ts absurdPercents. The attribution that fed the Brief such shares (causal.ts) no longer states a segment's share when it exceeds the whole move, and a KPI change that large is described by its two values.",
    onFail: "The clause holding it is dropped when its sentence stands without it, else the sentence; a caption or subtitle left empty is dropped, and a story whose title or lead is left empty is not shown.",
    surfaces: ["report", "executive"],
  },
  {
    id: "R31",
    title: "A headline never says all is well while a number is behind plan",
    ai: "Never write that everything is fine, quiet or on track while a headline number is behind its plan or flagged.",
    enforcement: "code",
    check: "The Brief's and an app's headline is chosen from the pinned numbers' statuses (lib/brief.ts composeHeadline): \"all quiet\" only when no number moved and none is behind its plan; a number behind plan makes the headline name it, and the stories fall back to the rule-based ones (which list it) when the AI's stories are empty.",
    onFail: "Fixed automatically — the headline names the number behind plan.",
    surfaces: ["executive"],
  },
  {
    id: "R32",
    title: "Executive stories use plain words",
    ai: "Write for an executive, not an analyst: no \"attribution\", \"deltas\", \"near-zero\", \"cohort\", \"p-value\", \"regression\" or \"impact weight\" — say what moved, by how much, and why, in everyday words.",
    enforcement: "code",
    check: "A short deny-list of analyst words (attribution, delta, near-zero, cohort, p-value, z-score, standard deviation, confidence interval, regression, impact weight, numerator/denominator, and their Thai and Chinese forms) in a Brief story; a word a KPI or report is named with passes.",
    onFail: "The clause or sentence holding it is dropped; a story whose title or lead is left empty is not shown.",
    surfaces: ["executive"],
  },
  {
    id: "R33",
    title: "Words have no broken characters",
    ai: "Every title, label and sentence is whole text: no replacement characters (U+FFFD, shown as a diamond with a question mark), no stray question marks inside a word, no Thai vowel or tone mark standing alone. If you cannot write a word correctly, choose a simpler word.",
    enforcement: "code",
    check: "A block's title, label, text or subtitle (and the report's name) holding U+FFFD, a Thai tone or vowel mark with no consonant before it, or a question mark between two letters of a word — brokenText() in reportRules.ts.",
    onFail: "A new report loses the block (its title is the reader's first sight of it) and the build's completion can add it back; a saved report is flagged and the verifier's repair brief names the rule.",
  },
  {
    id: "R34",
    title: "A percent card shows a percent",
    ai: "A KPI formatted as a percent holds a ratio (0.18 prints 18%). Never divide a baht total by 100 and call it a percent; divide one amount by another, or format the card as a number.",
    enforcement: "code",
    check: "A KPI formatted as a percent whose value is beyond ±10 (printing more than ±1000%) — reportRulesNumbers.ts percentCardViolations.",
    onFail: "On a new report the card is removed and named in the quality note; on a saved report it is flagged and the verifier's repair brief names the rule.",
  },
  {
    id: "R35",
    title: "A chart over time has one point per date",
    ai: "A line, area or bar chart over dates (days, months, years) shows one row per date: GROUP BY the date and add up the measure. Never leave one row per branch, product or channel under each date; to compare them, give each its own column (one series each) or a separate chart.",
    enforcement: "code",
    check: "A line, area or bar chart with no colour split, whose x is a date-like column, and whose rows repeat at least two of its x values — reportRulesNumbers.ts (R35).",
    onFail: "On a new report the chart is removed and named in the quality note; on a saved report it is flagged and the verifier's repair brief names the rule.",
  },
];

const appliesTo = (r: ReportRule, s: "report" | "executive") => (r.surfaces ?? ["report"]).includes(s);

/**
 * Who wrote a saved report's words, for checking one generated before the
 * gate stamped it: the rule-based fallback (autoCurf.ts heuristicReport)
 * signs its subtitle "… auto-generated by Curf"; a Master Builder report
 * planned as autoCurf/generate otherwise had a model write them.
 */
export function authorshipOf(subtitle: string | undefined, planKind?: string): "ai" | "template" {
  if (/auto-generated by Curf/.test(subtitle ?? "")) return "template";
  return planKind === "autoCurf" || planKind === "generate" ? "ai" : "template";
}

/** The rules as prompt lines, for the models that design a report. */
export function rulesForPrompt(): string[] {
  return REPORT_RULES.filter((r) => appliesTo(r, "report")).map((r) => `- ${r.ai}`);
}

/** The rules as prompt lines, for the models that write the narrative executives read (the Brief's stories). */
export function narrativeRulesForPrompt(): string[] {
  return REPORT_RULES.filter((r) => appliesTo(r, "executive")).map((r) => `- ${r.ai}`);
}

// ── Detection ──────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
export type Dataset = Record<string, Row[]>;

export type Violation = {
  rule: RuleId;
  /** A block id, or "caption" / "subtitle". */
  target: string;
  /** Short English description, for the reviewer and the logs. */
  detail: string;
  /** Deterministic repair the gate applies itself. */
  fix?: { kind: "limit"; queryId: string; n: number } | { kind: "height"; h: number } | ScriptFix | NumberRuleFix;
  /** R26 with no fix yet: the rate column whose parts the gate should look for, then ask again with `rateParts`. */
  probe?: { table: string; column: string };
};

/**
 * R29: a leaked script taken out of the report's words. `lang` set: the
 * translation at `key` (a block's i18n path, or "nameI18n"/"descriptionI18n"
 * on the report when `blockId` is null) is deleted, so the reader sees the
 * report's own words. `lang` null: the base field `key` becomes `to`.
 */
export type ScriptFix = { kind: "script"; blockId: string | null; lang: string | null; key: string; to: string | null };

/** The most rows a table on a card lists: longer lists scroll in a card for thousands of pixels (R23). */
export const TABLE_CARD_MAX_ROWS = 25;

/** Cut a query to `n` rows — its own LIMIT when it ends with one, else wrapped. */
export function withLimit(sql: string, n: number): string {
  const trailing = /\blimit\s+\d+\s*;?\s*$/i;
  return trailing.test(sql) ? sql.replace(trailing, `LIMIT ${n}`) : `SELECT * FROM (${sql.replace(/;\s*$/, "")}) AS limited LIMIT ${n}`;
}

/** Whether the table's query can be cut for it alone: no other block, and no drill-down, reads it. */
export function limitableQuery(report: Report, queryId: string): boolean {
  return JSON.stringify(report.pages).split(`"${queryId}"`).length - 1 === 1;
}

/** The count a title promises: "Top 10", "10 อันดับ", "อันดับ 1-10", "前10". */
export function topNFromTitle(title: unknown): number | null {
  if (typeof title !== "string") return null;
  const m =
    title.match(/\btop[\s-]*(\d{1,3})\b/i) ??
    title.match(/(\d{1,3})\s*อันดับ/) ??
    // "20 คู่แรก", "15 โครงการแรก" — the first N of something.
    title.match(/(\d{1,3})\s*(?:คู่|รายการ|โครงการ|สินค้า|ราย|แห่ง|สาขา|ลูกค้า)?\s*แรก/) ??
    // "ซื้อร่วมกันมากที่สุด 12 คู่", "ยอดขายสูงสุด 10 รายการ" — the most / highest / lowest N.
    title.match(/(?:มาก|สูง|ต่ำ|น้อย)(?:ที่)?สุด\s*(\d{1,3})\s*(?:คู่|รายการ|โครงการ|สินค้า|ราย|แห่ง|สาขา|ลูกค้า|อันดับ)/) ??
    title.match(/อันดับ(?:ที่)?\s*1\s*[-–]\s*(\d{1,3})/) ??
    title.match(/前\s*(\d{1,3})/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
}

/** Rows a horizontal bar gets per category, and the chrome around them (title, padding, axis). */
const H_BAR_ROW_PX = 26;
const H_BAR_CHROME_PX = 96;
const GRID_ROW_PX = 40;
/** Tallest a generated chart is made (grid rows). */
export const MAX_CHART_H = 20;
const PIE_MAX_SLICES = 8;

/** Grid rows a horizontal bar with `rows` categories needs to read one label per bar. */
export function horizontalBarHeight(rows: number): number {
  return Math.ceil((rows * H_BAR_ROW_PX + H_BAR_CHROME_PX) / GRID_ROW_PX);
}

/**
 * One grid row as the viewer draws it: 40px plus the 12px gap to the next.
 * The bar formula above leaves the gaps out and errs tall, which a bar can
 * afford; a table or heatmap sized that way shows a band of empty card.
 */
const GRID_STEP_PX = 52;
/** Card frame around a table's scroll box (padding, title line, border: measured 54) plus the 12px gap a grid height leaves out. */
const TABLE_CHROME_PX = 66;
const TABLE_HEAD_PX = 37;
const TABLE_LINE_PX = 41;
/** A wrapped cell's extra line (text-sm, 20px line height). */
const TABLE_WRAP_PX = 20;
/** The most rows a table is sized for: past it the list scrolls in its card instead of growing a screen tall. */
export const TABLE_MAX_LINES = 30;
export const TABLE_MAX_H = 28;
/**
 * The tallest a table of up to TABLE_MAX_LINES rows is made. Wrapped cells (Thai
 * headings and names in a narrow column) can need twice the height of one-line
 * rows; capping those at TABLE_MAX_H left a 25-row table scrolling inside its
 * card, two screens of text in a 1444px box (Public Works build, 2026-10-06).
 * A longer list still stops at TABLE_MAX_H and scrolls.
 */
export const TABLE_MAX_H_WRAPPED = 60;
/**
 * What the estimate adds for the browser's line breaking, which the glyph table
 * can't reproduce exactly (Thai especially): a card a row short scrolls, one
 * 2% tall doesn't. Measured over 56 tables in three languages, without it 3
 * came out a grid row short; with it none.
 */
const TABLE_SLACK = 1.02;

/**
 * Grid rows for a table of `rows` one-line rows, from a row count alone —
 * for callers that have no cell text yet (autoCurf's layout pass).
 */
export function tableBlockHeight(rows = 20): number {
  return Math.min(TABLE_MAX_H, Math.max(6, Math.ceil((TABLE_CHROME_PX + TABLE_HEAD_PX + TABLE_LINE_PX * Math.min(rows, TABLE_MAX_LINES)) / GRID_STEP_PX)));
}

/**
 * The page's own fonts, in px per character (measured in the browser on the
 * seeded apps, var/r6): Instrument Sans for Latin and digits, Prompt for Thai.
 * A Thai vowel or tone mark above/below a consonant adds little. Cells are
 * text-sm (14px); headers 11px uppercase with letter-spacing.
 */
type Glyph =
  | "thai" | "mark" | "tone" | "lead" | "baht" | "wide" | "digit" | "comma" | "dot" | "percent" | "paren" | "dash" | "slash"
  | "lowern" | "lower" | "lowerw" | "uppern" | "upper" | "upperw" | "space" | "other";
const CELL_PX: Record<Glyph, number> = {
  thai: 7.85, mark: 1.4, tone: 0.4, lead: 5.15, baht: 11, wide: 14, digit: 7.75, comma: 3.75, dot: 2.4, percent: 10.7, paren: 5.6, dash: 7, slash: 8.3,
  lowern: 4.5, lower: 7.8, lowerw: 11.9, uppern: 4, upper: 9.35, upperw: 12, space: 3.3, other: 7,
};
/** Headings are drawn in capitals, so only the capital classes count. */
const HEAD_PX: Record<Glyph, number> = {
  thai: 6.7, mark: 1.1, tone: 0.25, lead: 4.6, baht: 9.15, wide: 11.5, digit: 6.6, comma: 3.5, dot: 2.45, percent: 8.75, paren: 5, dash: 5.85, slash: 6.8,
  lowern: 3.4, lower: 7.85, lowerw: 10.4, uppern: 3.4, upper: 7.85, upperw: 10.4, space: 3, other: 6.4,
};
/** px-3 either side of a cell. */
const TABLE_CELL_PAD_PX = 24;
/** The app's content width at a 1440px screen, and the grid's 12px gaps — a block's width follows from its grid columns. */
const APP_CONTENT_PX = 1028;
const GRID_GAP_PX = 12;
/** px-5 and the border around the table inside its card. */
const TABLE_CARD_INSET_PX = 42;

function glyphOf(ch: string): Glyph {
  const c = ch.codePointAt(0)!;
  if (c >= 0x0e00 && c <= 0x0e7f) {
    if (c === 0x0e3f) return "baht";
    if (c >= 0x0e48 && c <= 0x0e4b) return "tone";
    if (c === 0x0e31 || (c >= 0x0e34 && c <= 0x0e3a) || (c >= 0x0e47 && c <= 0x0e4e)) return "mark";
    return c === 0x0e40 || c === 0x0e43 || c === 0x0e44 ? "lead" : "thai";
  }
  if (ch >= "0" && ch <= "9") return "digit";
  if (ch >= "a" && ch <= "z") return "ijltfr".includes(ch) ? "lowern" : "mw".includes(ch) ? "lowerw" : "lower";
  if (ch >= "A" && ch <= "Z") return "IJ".includes(ch) ? "uppern" : "MW".includes(ch) ? "upperw" : "upper";
  switch (ch) {
    case ",": return "comma";
    case ".": return "dot";
    case "%": return "percent";
    case "(": case ")": case "[": case "]": return "paren";
    case "-": case "–": case "—": return "dash";
    case "/": return "slash";
    case " ": return "space";
  }
  return c > 0x2e7f ? "wide" : "other";
}

function textPx(s: string, px: Record<Glyph, number>): number {
  let w = 0;
  for (const ch of s) w += px[glyphOf(ch)];
  return w;
}

const thaiWords = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("th", { granularity: "word" }) : null;

/** The pieces a browser may break a cell between: words, and — Thai having no spaces — dictionary words. */
function breakable(text: string): string[] {
  const out: string[] = [];
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    if (thaiWords && /[฀-๿]/.test(word)) for (const seg of thaiWords.segment(word)) out.push(seg.segment);
    else out.push(word);
  }
  return out;
}

/** What a table column needs to be laid out: the key, how its cells format, and its heading. */
export type TableColumnSpec = { key: string; type?: string; format?: string; label?: string };

/**
 * The columns of a table block, once per language the block is written in
 * (its own, then each in its `i18n`) — a heading is longer in some languages
 * than others, and one report serves them all.
 */
export function tableColumnSpecs(block: { config?: any; i18n?: Record<string, Record<string, string>> }, rows: Row[]): TableColumnSpec[][] {
  const cols: any[] = Array.isArray(block.config?.columns) && block.config.columns.length
    ? block.config.columns
    : Object.keys(rows[0] ?? {}).map((key) => ({ key }));
  return [undefined, ...Object.keys(block.i18n ?? {})].map((lang) =>
    cols.map((c, i) => ({
      key: String(c?.key ?? c),
      type: c?.type,
      format: c?.format,
      label: (lang && block.i18n?.[lang]?.[`columns.${i}.label`]) || c?.label,
    })));
}

const cellText = (r: Row, c: TableColumnSpec) => {
  const v = r?.[c.key];
  return v == null || v === "" ? "" : formatCell(v, c.type ?? "string", c.format);
};

/**
 * Each column's width in a table `widthPx` wide, the way a browser's auto
 * layout gives it: its widest cell while the columns all fit; otherwise from
 * its widest word (or its heading — headings never wrap) up toward its widest
 * cell, in proportion to the room left.
 */
export function tableColumnWidths(rows: Row[], columns: TableColumnSpec[], widthPx: number): number[] {
  const max: number[] = [], min: number[] = [];
  columns.forEach((c) => {
    const head = textPx((c.label ?? c.key).toUpperCase(), HEAD_PX);
    let widest = head, word = head;
    for (const r of rows) {
      const t = cellText(r, c);
      const whole = textPx(t, CELL_PX);
      widest = Math.max(widest, whole);
      // A short string never wraps (the cell is nowrap), and a number has no break.
      const unbreakable = typeof r?.[c.key] !== "string" || String(r[c.key]).length <= 12;
      word = Math.max(word, unbreakable ? whole : Math.max(0, ...breakable(t).map((p) => textPx(p, CELL_PX))));
    }
    max.push(widest + TABLE_CELL_PAD_PX);
    min.push(Math.min(word, widest) + TABLE_CELL_PAD_PX);
  });
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const sumMax = sum(max), sumMin = sum(min);
  if (sumMax <= widthPx) return max.map((m) => m + ((widthPx - sumMax) * m) / sumMax);
  if (sumMin >= widthPx) return min;
  return min.map((m, i) => m + ((widthPx - sumMin) * (max[i]! - m)) / Math.max(1, sumMax - sumMin));
}

/**
 * The height, in px, of each of the `rows` in the viewer's table: every cell
 * wrapped greedily into its column (`tableColumnWidths`), a row as tall as its
 * tallest cell. Cell text is what the table prints (formatCell), so
 * "14,609.7" is measured, not 14609.7123.
 */
export function tableRowHeights(rows: Row[], columns: TableColumnSpec[], widthPx: number): number[] {
  const col = tableColumnWidths(rows, columns, widthPx);
  return rows.map((r) => {
    let lines = 1;
    columns.forEach((c, i) => {
      const t = cellText(r, c);
      const room = col[i]! - TABLE_CELL_PAD_PX;
      if (textPx(t, CELL_PX) <= room) return;
      let line = 0, n = 1;
      for (const w of breakable(t)) {
        const px = textPx(w, CELL_PX);
        if (line > 0 && line + CELL_PX.space + px > room) { n++; line = px; } else line += (line > 0 ? CELL_PX.space : 0) + px;
      }
      lines = Math.max(lines, n);
    });
    return TABLE_LINE_PX + (lines - 1) * TABLE_WRAP_PX;
  });
}

/** A block `w` grid columns wide, in px, in the app at a 1440px screen (the width model the table sizing and the verify probes share). */
export function blockCardWidthPx(w = 12): number {
  const span = Math.min(12, Math.max(1, w));
  return ((APP_CONTENT_PX - 11 * GRID_GAP_PX) * span) / 12 + GRID_GAP_PX * (span - 1);
}

/** The room a table's columns have inside a card `w` columns wide. */
export function tableInnerWidthPx(w = 12): number {
  return blockCardWidthPx(w) - TABLE_CARD_INSET_PX;
}

/**
 * Grid rows for a table showing these `rows`, each as tall as its text wraps
 * to. Estimates the viewer's own layout (`tableRowHeights`) for a block `w`
 * grid columns wide, so a table is read whole instead of scrolling inside its
 * card — and so an author never has to override the number by hand. A bare
 * key list measures the keys as the headings and the values as plain text.
 */
export function tableHeightForRows(rows: Row[], columns: Array<string | TableColumnSpec>, w = 12, opts: { showTotals?: boolean } = {}): number {
  const cardPx = blockCardWidthPx(w);
  const specs = columns.map((c) => (typeof c === "string" ? { key: c } : c));
  const linesPx = tableRowHeights(rows.slice(0, TABLE_MAX_LINES), specs, cardPx - TABLE_CARD_INSET_PX).reduce((a, b) => a + b, 0) * TABLE_SLACK;
  return Math.min(rows.length > TABLE_MAX_LINES ? TABLE_MAX_H : TABLE_MAX_H_WRAPPED, Math.max(6, Math.ceil((TABLE_CHROME_PX + TABLE_HEAD_PX + (opts.showTotals ? TABLE_HEAD_PX : 0) + linesPx) / GRID_STEP_PX)));
}

/** Grid rows for a table block showing `rows`: the tallest it comes out in any language it carries. */
export function tableHeightForBlock(block: { w?: number; config?: any; i18n?: Record<string, Record<string, string>> }, rows: Row[]): number {
  const cols: any[] = block.config?.columns ?? [];
  const showTotals = !!block.config?.showTotals && cols.some((c) => c?.total && c.total !== "none");
  return Math.max(...tableColumnSpecs(block, rows).map((specs) => tableHeightForRows(rows, specs, block.w, { showTotals })));
}

/** A grid heatmap's row of cells (28px + 2px gap) at the scale a full-width card usually draws it. */
const HEAT_ROW_PX = 36;
const HEAT_CHROME_PX = 100;
/**
 * Grid rows for a grid heatmap with `rows` rows of cells: enough that it is
 * read whole, few enough that a two-row grid isn't a band of empty card
 * (Siam Tech's churn by segment sat in nine, 2026-10-03). The heatmap
 * fits whatever card it gets, so this only has to be close.
 */
export function gridHeatmapHeight(rows: number): number {
  return Math.min(MAX_CHART_H, Math.max(4, Math.ceil((HEAT_CHROME_PX + HEAT_ROW_PX * rows) / GRID_STEP_PX)));
}

const CONDITION_WORDS = /\bnull\b|\bnever\b|\bwithout\b|\bonly\b|\bexcluding\b|\bexcept\b|ไม่เคย|ยังไม่|ไม่มี|เฉพาะ|ยกเว้น|ที่ว่าง|เป็นค่าว่าง|未|没有|仅|只有|除外|为空/i;

/** A label that is nothing but a period: "ปีงบประมาณล่าสุด", "Latest month", "本月". */
const PERIOD_ONLY_LABEL = /^\s*(?:(?:latest|current|last|this|most recent)\s+)?(?:fiscal\s+year|year|month|quarter|week|period)(?:\s+(?:latest|current))?\s*$|^\s*(?:ปีงบประมาณ|ปีงบ|ปี|เดือน|ไตรมาส|สัปดาห์|งวด)\s*(?:ล่าสุด|ปัจจุบัน|นี้)?\s*$|^\s*(?:最新|当前|本|上)?(?:财年|财政年度|年度|年|月|季度|周|期间)\s*$/i;

/** The aggregate words a KPI label can use, and the SQL aggregates each allows. */
const AGGREGATE_WORDS: Array<{ words: RegExp; allowed: string[] }> = [
  { words: /เฉลี่ย|\baverage\b|\bavg\b|\bmean\b|平均/i, allowed: ["AVG"] },
  { words: /สูงสุด|มากที่สุด|\bmax(imum)?\b|\bhighest\b|\blargest\b|最高|最大/i, allowed: ["MAX"] },
  { words: /ต่ำสุด|น้อยที่สุด|\bmin(imum)?\b|\blowest\b|\bsmallest\b|最低|最小/i, allowed: ["MIN"] },
  { words: /รวม|\btotal\b|\bsum\b|合计|总计|总额/i, allowed: ["SUM", "COUNT"] },
  // A label that is only a period ("ปีงบประมาณล่าสุด", "Latest month") shows
  // that period, which is a MIN or MAX of the column — not how many rows it
  // has (อบต. บ้านกลาง's "ปีงบประมาณล่าสุด: 396", 2026-10-03).
  { words: PERIOD_ONLY_LABEL, allowed: ["MIN", "MAX"] },
];

export const queryIdOf = (b: { config?: unknown }): string | null => {
  const q = (b as any).config?.queryId;
  return typeof q === "string" ? q : null;
};
/** Grow a block and push everything below it down by the same amount. */
export function resizeBlock(report: Report, id: string, h: number): Report {
  return {
    ...report,
    pages: report.pages.map((p) => {
      const target = p.blocks.find((b) => b.id === id);
      if (!target) return p;
      const bottom = target.y + target.h;
      const delta = h - target.h;
      return { ...p, blocks: p.blocks.map((b) => (b.id === id ? { ...b, h } : b.y >= bottom ? { ...b, y: b.y + delta } : b)) };
    }),
  };
}

export const blockTitle = (b: { config?: unknown; type: string; id: string }): string => {
  const c = (b as any).config ?? {};
  return c.title ?? c.label ?? c.text ?? `${b.type} ${b.id}`;
};

/** Split a SELECT list on its top-level commas (not inside parentheses or quotes). */
function selectItems(sql: string): string[] {
  const m = sql.match(/\bselect\b([\s\S]*?)\bfrom\b/i);
  if (!m) return [];
  const body = m[1]!;
  const out: string[] = [];
  let depth = 0, quote: string | null = null, cur = "";
  for (const ch of body) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The SELECT item that produces `alias` — in the outer query, after any `WITH x AS (…)`. */
export function itemFor(sql: string, alias: string): string | null {
  const cteEnd = sql.search(/\)\s*select\b/i);
  const items = selectItems(cteEnd >= 0 ? sql.slice(cteEnd + 1) : sql);
  const aliasRe = new RegExp(`\\bas\\s+"?${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\s*$`, "i");
  return items.find((i) => aliasRe.test(i)) ?? null;
}

export function aggregateOf(item: string): string | null {
  const m = item.match(/\b(SUM|AVG|MIN|MAX|COUNT)\s*\(/i);
  return m ? m[1]!.toUpperCase() : null;
}

/** A column that holds a level at a point in time (a balance, a stock), not an amount for the period. */
const BALANCE_COLUMN = /(^|_)(balance|closing|ending|opening|beginning|end|begin|on_?hand|stock|inventory|headcount|outstanding)(_|$)|คงเหลือ|ยกมา|คงค้าง|余额|库存|期末|期初/i;
/**
 * A column that IS the period a row belongs to (month, fiscal_year, a
 * snapshot date) — not a date something happened on (origination_date,
 * last_count_date). A table with one keeps a row per period, so a balance in
 * it repeats every period; a table without one is a snapshot.
 */
const PERIOD_OF_ROW = /^(year|yr|fy|fiscal_year|quarter|qtr|fiscal_quarter|month|mth|fiscal_month|period|week|day|date|as_of|as_of_date|snapshot_date|report_date|period_start|period_end|month_start|week_start)$|^(ปี|ปีงบ|ปีงบประมาณ|เดือน|ไตรมาส|งวด)$|^(年|月|季度|期间)$/i;
/** A column that names a period. */
const PERIOD_COLUMN = /(^|_)(year|yr|fy|quarter|qtr|month|mth|period|date|day|week)(_|$)|ปี|เดือน|ไตรมาส|วันที่|年|月|季度|日期/i;

/** The columns a SUM(...) in this SELECT item adds up. */
function summedColumns(item: string): string[] {
  return [...item.matchAll(/\bSUM\s*\(\s*(?:CAST\s*\(\s*)?(?:CASE\b[\s\S]*?\bTHEN\s+(?:CAST\s*\(\s*)?)?(?:"?\w+"?\.)?"?([\p{L}\w]+)"?/giu)].map((m) => m[1]!);
}

/** Whether a table the query reads keeps a row per period — by its columns when known, else by the query naming one. */
function keepsRowPerPeriod(sql: string, tableColumns: Record<string, string[]> | undefined): boolean {
  const tables = [...sql.matchAll(/\b(?:from|join)\s+"?([\p{L}\w]+)"?/giu)].map((m) => m[1]!);
  const known = tables.filter((t) => tableColumns?.[t]);
  if (known.length > 0) return known.some((t) => tableColumns![t]!.some((c) => PERIOD_OF_ROW.test(c)));
  return [...sql.matchAll(/"?([\p{L}\w]+)"?/gu)].some((m) => PERIOD_OF_ROW.test(m[1]!));
}

/** Whether the query holds one period per value it returns (so a balance in it isn't added across periods). */
function onePeriodPerValue(sql: string, item: string): boolean {
  const period = (s: string) => [...s.matchAll(/"?([\p{L}\w]+)"?/gu)].some((m) => PERIOD_COLUMN.test(m[1]!));
  const groupBy = sql.match(/\bgroup\s+by\b([\s\S]*?)(?:\border\s+by\b|\bhaving\b|\blimit\b|$)/i)?.[1];
  if (groupBy && period(groupBy)) return true;
  // A CASE WHEN on a period inside the SUM (SUM(CASE WHEN year = 2568 THEN balance END)).
  if (/\bcase\s+when\b/i.test(item) && period(item.match(/\bwhen\b([\s\S]*?)\bthen\b/i)?.[1] ?? "")) return true;
  // WHERE year = …, year IN (…), date = (SELECT MAX(date) …).
  const where = sql.match(/\bwhere\b([\s\S]*?)(?:\bgroup\s+by\b|\border\s+by\b|\blimit\b|$)/i)?.[1] ?? "";
  if ([...where.matchAll(/"?([\p{L}\w]+)"?\s*(?:\)\s*)?(?:=|\bin\b)/giu)].some((m) => PERIOD_COLUMN.test(m[1]!))) return true;
  // The latest period only: ORDER BY a period … LIMIT 1.
  const orderBy = sql.match(/\border\s+by\b([\s\S]*?)\blimit\s+1\b/i)?.[1];
  return !!orderBy && period(orderBy);
}

/** Whether a query filters beyond the composer's own "x IS NOT NULL" guard. */
function hasCondition(sql: string, item: string | null): boolean {
  if (item && /\bcase\s+when\b|\bfilter\s*\(\s*where\b/i.test(item)) return true;
  const stripped = sql.replace(/\bwhere\s+"[^"]+"\s+is\s+not\s+null\b/gi, "");
  return /\bwhere\b|\bhaving\b/i.test(stripped);
}

/** Every rule code can check on its own, against a report and the rows its queries returned. */
export function detectViolations(
  report: Report,
  dataset: Dataset,
  opts: {
    caption?: string;
    subtitle?: string;
    /** The columns of the tables the queries read, by table name — what tells a per-period table from a snapshot (R10). */
    tableColumns?: Record<string, string[]>;
    /** The KPIs the brief named and the target it gave each (R12 sets a matching KPI's plan from it). */
    kpiAsks?: KpiAsk[];
    /** R26: the numerator and denominator of the rate columns the gate probed ("table.column"). */
    rateParts?: Record<string, RateParts>;
    /** The language the report was built in — its own words are checked against that script (R29). */
    locale?: string;
  } = {},
): Violation[] {
  const out: Violation[] = [];
  const blocks = report.pages.flatMap((p) => p.blocks);
  const sqlById = new Map(report.dataSources.map((d) => [d.id, d.sql ?? ""]));
  const usersOf = new Map<string, number>();
  for (const b of blocks) { const q = queryIdOf(b); if (q) usersOf.set(q, (usersOf.get(q) ?? 0) + 1); }

  for (const b of blocks) {
    const cfg = (b as any).config ?? {};
    const qid = queryIdOf(b);
    if (!qid) continue;
    const rows = dataset[qid] ?? [];
    const sql = sqlById.get(qid) ?? "";

    // R1 — a promised count.
    if (b.type === "chart" || b.type === "table") {
      const n = topNFromTitle(cfg.title);
      if (n != null && rows.length > n) {
        out.push({
          rule: "R1", target: b.id,
          detail: `"${cfg.title}" promises ${n} but its query returns ${rows.length} rows`,
          // A query two blocks share can't be cut for one of them.
          ...(usersOf.get(qid) === 1 ? { fix: { kind: "limit" as const, queryId: qid, n } } : {}),
        });
      }
    }

    // R2 — a condition only in the words.
    const words = b.type === "kpi" ? cfg.label : b.type === "chart" ? cfg.title : null;
    const item = b.type === "kpi" && typeof cfg.valueField === "string" ? itemFor(sql, cfg.valueField) : null;
    if (typeof words === "string" && CONDITION_WORDS.test(words) && sql && !hasCondition(sql, item)) {
      out.push({ rule: "R2", target: b.id, detail: `"${words}" names a condition, but its query has no WHERE or CASE WHEN (${sql.slice(0, 160)})` });
    }

    // R3 — the calculation word.
    if (b.type === "kpi" && typeof cfg.label === "string" && item) {
      const agg = aggregateOf(item);
      const expected = AGGREGATE_WORDS.filter((a) => a.words.test(cfg.label)).flatMap((a) => a.allowed);
      if (agg && expected.length > 0 && !expected.includes(agg)) {
        out.push({ rule: "R3", target: b.id, detail: `"${cfg.label}" reads as ${[...new Set(expected)].join("/")} but its query computes ${agg}` });
      }
    }

    // R10 — a balance added up across periods. The value a KPI shows, and each value a chart plots.
    const valueFields: string[] = b.type === "kpi" && typeof cfg.valueField === "string" ? [cfg.valueField]
      : b.type === "chart" ? [...(Array.isArray(cfg.yFields) ? cfg.yFields : []), ...(typeof cfg.valueField === "string" ? [cfg.valueField] : [])].filter((f: unknown): f is string => typeof f === "string")
      : [];
    for (const field of valueFields) {
      const fieldItem = itemFor(sql, field);
      if (!fieldItem) continue;
      const balance = summedColumns(fieldItem).find((c) => BALANCE_COLUMN.test(c));
      if (balance && keepsRowPerPeriod(sql, opts.tableColumns) && !onePeriodPerValue(sql, fieldItem)) {
        out.push({ rule: "R10", target: b.id, detail: `"${blockTitle(b)}" adds up ${balance}, a balance, across every period in its table — the same money counted once per period` });
        break;
      }
    }

    // R11 — one KPI, two measures in its label.
    if (b.type === "kpi" && typeof cfg.label === "string") {
      const named = AGGREGATE_WORDS.filter((a) => a.words.test(cfg.label)).map((a) => a.allowed[0]);
      if (new Set(named).size >= 2) {
        out.push({ rule: "R11", target: b.id, detail: `"${cfg.label}" names ${named.join(" and ").toLowerCase()} — two numbers — but a KPI shows one` });
      }
    }

    // R6 — readable at its size.
    if (b.type === "chart") {
      const categorical = cfg.chartType === "bar" && cfg.orientation === "horizontal";
      if (categorical && rows.length > 0) {
        const need = horizontalBarHeight(rows.length);
        if (need > MAX_CHART_H) {
          out.push({ rule: "R6", target: b.id, detail: `"${cfg.title}" ranks ${rows.length} categories — more than fit even at the tallest size` });
        }
        const h = Math.min(Math.max(need, 6), MAX_CHART_H);
        if (b.h < h) out.push({ rule: "R6", target: b.id, detail: `"${cfg.title}" is too short for ${rows.length} bars`, fix: { kind: "height", h } });
      }
      if ((cfg.chartType === "pie" || cfg.chartType === "donut") && rows.length > PIE_MAX_SLICES) {
        out.push({ rule: "R6", target: b.id, detail: `"${cfg.title}" has ${rows.length} slices` });
      }
    }
    // R23 — a table on a card is a short list; the rest opens from a drill-down.
    if (b.type === "table" && rows.length > TABLE_CARD_MAX_ROWS) {
      const promised = topNFromTitle(cfg.title);
      out.push({
        rule: "R23", target: b.id,
        detail: `"${cfg.title ?? b.id}" lists ${rows.length} rows on a card (more than ${TABLE_CARD_MAX_ROWS}): the card scrolls`,
        ...(limitableQuery(report, qid) && (promised == null || promised <= TABLE_CARD_MAX_ROWS) ? { fix: { kind: "limit" as const, queryId: qid, n: TABLE_CARD_MAX_ROWS } } : {}),
      });
    }
    // A grid heatmap and a table are sized to the rows they show. Too short
    // grows; too tall shrinks only at full width — a half-width block's row
    // partner may still need the height.
    const fitted = rows.length === 0 ? null
      : b.type === "heatmap" && cfg.mode === "grid" && typeof cfg.yField === "string"
        ? { h: gridHeatmapHeight(new Set(rows.map((r) => String(r?.[cfg.yField] ?? "—"))).size), what: "rows of cells" }
      : b.type === "table"
        ? { h: tableHeightForBlock(b, rows), what: "lines" }
      : null;
    if (fitted && (b.h < fitted.h || (b.h > fitted.h && b.w >= 12))) {
      const name = cfg.title ?? b.id;
      out.push({ rule: "R6", target: b.id, detail: `"${name}" is ${b.h < fitted.h ? "too short" : "too tall"} for its ${fitted.what}`, fix: { kind: "height", h: fitted.h } });
    }
  }

  // R12-R18 — what the report's numbers and words say about each other.
  out.push(...detectNumberRules(report, dataset, { tableColumns: opts.tableColumns, kpiAsks: opts.kpiAsks, rateParts: opts.rateParts }).filter((v) => !v.info));

  // R4 — figures in the prose.
  const ground = groundingFor(report, dataset);
  for (const [target, text] of [["caption", opts.caption], ["subtitle", opts.subtitle]] as const) {
    if (!text) continue;
    // Prose that says it describes the sample is, by its own words, not
    // about the results — whatever its figures happen to match.
    if (SAMPLE_WORDS.test(text)) {
      out.push({ rule: "R4", target, detail: `the ${target} says it describes sample rows, not the results` });
      continue;
    }
    const missing = ungroundedNumbers(text, ground);
    if (missing.length > 0) out.push({ rule: "R4", target, detail: `the ${target} states ${missing.join(", ")}, which the results don't show` });
    // R30 — a percentage no reader can believe.
    const absurd = absurdPercents(text);
    if (absurd.length > 0) out.push({ rule: "R30", target, detail: `the ${target} states ${absurd.join(", ")}, beyond any share or change a reader can use` });
  }

  out.push(...detectScriptLeaks(report, dataset, opts));
  out.push(...detectBrokenText(report));
  return out;
}

/** A Thai mark that cannot stand first: a vowel above/below or a tone mark with nothing before it, or after a space. */
const THAI_ORPHAN_MARK = /(?:^|[\s(\[\-–/])[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/;
/** A question mark with a letter on each side: a character lost on its way in ("จาดซื้?จาดจ้าง"), not a question. */
const INNER_QUESTION = /[\p{L}\p{M}]\?[\p{L}\p{M}]/u;

/** R33: what in `text` is broken, or null. */
export function brokenText(text: string): string | null {
  if (text.includes("\uFFFD")) return "a replacement character";
  if (THAI_ORPHAN_MARK.test(text)) return "a Thai vowel or tone mark with no consonant";
  if (INNER_QUESTION.test(text)) return "a question mark inside a word";
  return null;
}

function detectBrokenText(report: Report): Violation[] {
  const out: Violation[] = [];
  const name = brokenText(report.name ?? "");
  if (name) out.push({ rule: "R33", target: "report", detail: `the report's name holds ${name}` });
  for (const b of report.pages.flatMap((p) => p.blocks)) {
    const cfg = (b as any).config ?? {};
    for (const key of TEXT_FIELDS) {
      const text = cfg[key];
      const broken = typeof text === "string" ? brokenText(text) : null;
      if (broken) { out.push({ rule: "R33", target: b.id, detail: `"${blockTitle(b)}" ${key} holds ${broken}` }); break; }
    }
  }
  return out;
}

/** Strings a report may quote in any script: values in its results, and its own names. */
export function quotableStrings(dataset: Dataset): string[] {
  const out = new Set<string>();
  for (const rows of Object.values(dataset)) {
    for (const row of rows.slice(0, 500)) {
      for (const v of Object.values(row ?? {})) if (typeof v === "string" && v.length >= 2 && v.length <= 200) out.add(v);
    }
    if (out.size > 5000) break;
  }
  return [...out];
}

/** The base fields of a block that hold words a reader sees. */
const TEXT_FIELDS = ["title", "label", "text", "subtitle"] as const;

/**
 * R29 — words for one language holding another script. Translations are
 * always checked (each says which language it is); the report's own words
 * only when the gate says which language it was built in. The caption and
 * subtitle a model wrote are the gate's to rewrite, so they are reported by
 * that name, not as a block.
 */
function detectScriptLeaks(report: Report, dataset: Dataset, opts: { caption?: string; subtitle?: string; locale?: string }): Violation[] {
  const out: Violation[] = [];
  let allow: string[] | null = null;
  const leaks = (text: unknown, lang: string): string[] => {
    if (typeof text !== "string" || !text) return [];
    // Cheap first pass with nothing allowed; only text that leaks pays for the quote list.
    if (scriptLeaks(text, lang).length === 0) return [];
    allow ??= quotableStrings(dataset);
    return scriptLeaks(text, lang, allow);
  };
  const base = (blockId: string | null, key: string, text: unknown, name: string) => {
    if (!opts.locale) return;
    const found = leaks(text, opts.locale);
    if (found.length === 0) return;
    const to = cleanScript(text as string, opts.locale, allow ?? undefined);
    out.push({
      rule: "R29", target: blockId ?? "report",
      detail: `${name} is meant to be ${opts.locale} but holds ${found.join(", ")}`,
      ...(to ? { fix: { kind: "script" as const, blockId, lang: null, key, to } } : {}),
    });
  };
  const translated = (blockId: string | null, lang: string, key: string, text: unknown, name: string) => {
    const found = leaks(text, lang);
    if (found.length === 0) return;
    out.push({ rule: "R29", target: blockId ?? "report", detail: `${name} (${lang}) holds ${found.join(", ")}`, fix: { kind: "script", blockId, lang, key, to: null } });
  };

  for (const map of ["nameI18n", "descriptionI18n"] as const) {
    for (const [lang, text] of Object.entries(((report as any)[map] ?? {}) as Record<string, string>)) {
      translated(null, lang, map, text, `the report's ${map === "nameI18n" ? "name" : "description"}`);
    }
  }
  base(null, "name", report.name, "the report's name");
  base(null, "description", report.description, "the report's description");
  for (const b of report.pages.flatMap((p) => p.blocks)) {
    const cfg = (b as any).config ?? {};
    const name = `"${blockTitle(b)}"`;
    for (const [lang, entries] of Object.entries(((b as any).i18n ?? {}) as Record<string, Record<string, string>>)) {
      for (const [path, text] of Object.entries(entries ?? {})) translated(b.id, lang, path, text, `${name} ${path}`);
    }
    for (const key of TEXT_FIELDS) {
      const text = cfg[key];
      if (typeof text !== "string") continue;
      const prose = key === "text" && b.type === "text" && opts.caption && text === opts.caption ? "caption"
        : key === "subtitle" && b.type === "title" && opts.subtitle && text === opts.subtitle ? "subtitle"
        : null;
      if (prose) {
        const found = opts.locale ? leaks(text, opts.locale) : [];
        if (found.length) out.push({ rule: "R29", target: prose, detail: `the ${prose} holds ${found.join(", ")}` });
        continue;
      }
      base(b.id, key, text, `${name} ${key}`);
    }
  }
  return out;
}

/** Apply an R29 fix: a translation with a leak is deleted, a base field takes its cleaned text. Null when there was nothing to change. */
export function applyScriptFix(report: Report, fix: ScriptFix): { report: Report; title: string } | null {
  const next = structuredClone(report);
  if (fix.blockId == null) {
    if (fix.lang) {
      const map = (next as any)[fix.key] as Record<string, string> | undefined;
      if (!map || !(fix.lang in map)) return null;
      delete map[fix.lang];
    } else {
      if (fix.to == null || (next as any)[fix.key] === fix.to) return null;
      (next as any)[fix.key] = fix.to;
    }
    return { report: next, title: next.name };
  }
  for (const p of next.pages) {
    const b = p.blocks.find((x) => x.id === fix.blockId) as any;
    if (!b) continue;
    if (fix.lang) {
      const entries = b.i18n?.[fix.lang];
      if (!entries || !(fix.key in entries)) return null;
      delete entries[fix.key];
      if (Object.keys(entries).length === 0) delete b.i18n[fix.lang];
    } else {
      if (fix.to == null || b.config?.[fix.key] === fix.to) return null;
      b.config[fix.key] = fix.to;
    }
    return { report: next, title: blockTitle(b) };
  }
  return null;
}

/** Words a caption uses when it was written from the sample rows it was shown. */
const SAMPLE_WORDS = /จากตัวอย่าง|ตัวอย่างข้อมูล|แถวตัวอย่าง|\bfrom the sample\b|\bin the sample\b|\bsample (rows|data)\b|样本|示例数据/i;

// ── R4: figures grounded in the results ────────────────────────────────

type Grounding = { values: number[]; digitStrings: Set<string>; titleNumbers: Set<number> };

const SCALE: Array<[RegExp, number]> = [
  [/^\s?พันล้าน/, 1e9], [/^\s?(?:bn|b)(?![a-z])/i, 1e9], [/^\s?ล้าน/, 1e6], [/^\s?m(?![a-z])/i, 1e6],
  [/^\s?แสน/, 1e5], [/^\s?หมื่น/, 1e4], [/^\s?พัน/, 1e3], [/^\s?k(?![a-z])/i, 1e3],
];

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return null;
}

/** Everything a stated figure may legitimately be: values, counts, totals, averages, shares and changes. */
export function groundingFor(report: Report, dataset: Dataset): Grounding {
  const values: number[] = [];
  const digitStrings = new Set<string>();
  for (const rows of Object.values(dataset)) {
    values.push(rows.length);
    const cols = new Map<string, number[]>();
    for (const row of rows) {
      for (const [k, v] of Object.entries(row)) {
        const n = num(v);
        if (n != null) { values.push(n); (cols.get(k) ?? cols.set(k, []).get(k)!).push(n); }
        else if (typeof v === "string") for (const d of v.replace(/,/g, "").match(/\d+(?:\.\d+)?/g) ?? []) digitStrings.add(d);
      }
    }
    for (const col of cols.values()) {
      const sum = col.reduce((a, b) => a + b, 0);
      values.push(sum, sum / col.length);
      // Shares of the column total and changes between two values — the
      // derived figures a caption states honestly ("30% of the total",
      // "up 12%"). Bounded: a ranking of a few dozen rows, not a table dump.
      if (col.length <= 60) {
        for (const a of col) {
          if (sum !== 0) values.push((a / sum) * 100);
          for (const b of col) if (b !== 0 && a !== b) values.push(((a - b) / Math.abs(b)) * 100, (a / b) * 100);
        }
      }
    }
  }
  const titleNumbers = new Set<number>();
  const titles = [report.name, ...report.pages.flatMap((p) => p.blocks.map((b) => {
    const c = (b as any).config ?? {};
    return [c.title, c.label, c.text && b.type === "title" ? c.text : null].filter(Boolean).join(" ");
  }))].join(" ");
  for (const d of titles.match(/\d+(?:\.\d+)?/g) ?? []) titleNumbers.add(Number(d));
  return { values, digitStrings, titleNumbers };
}

/** The figures in `text` that nothing in the results backs up, as written. */
export function ungroundedNumbers(text: string, g: Grounding): string[] {
  const missing: string[] = [];
  const re = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const whole = m[1]!.replace(/,/g, "");
    const decimals = m[2] ?? "";
    const after = text.slice(re.lastIndex);
    // Part of a code, not a figure: "X12", "P3", "5G".
    if (/[A-Za-z]/.test(text[m.index - 1] ?? "") || /^[A-Za-z]/.test(after) && !/^(?:k|m|b|bn)(?![a-z])/i.test(after)) continue;
    // Quoted from a name or code the results carry ("ออปโป้เรโน่14", "สาขา 168").
    if (g.digitStrings.has(whole + (decimals ? "." + decimals : ""))) continue;
    const scale = SCALE.find(([r]) => r.test(after))?.[1] ?? 1;
    const isPct = /^\s?%/.test(after);
    const n = Number(`${whole}${decimals ? "." + decimals : ""}`) * scale;
    const half = 0.5 * Math.pow(10, -decimals.length) * scale;
    if (grounded(n, half, isPct, decimals.length === 0 && scale === 1 ? whole : null, g)) continue;
    missing.push(m[0] + (isPct ? "%" : scale !== 1 ? after.match(/^\s?\S+/)?.[0]?.trim() ?? "" : ""));
  }
  return missing;
}

function grounded(n: number, half: number, isPct: boolean, digits: string | null, g: Grounding): boolean {
  if (digits != null) {
    if (g.digitStrings.has(digits)) return true;
    const i = Number(digits);
    // Ranks and small counts ("3 สาขา", "top 5"), and years in either era.
    if (i <= 12 || (i >= 1900 && i <= 2100) || (i >= 2443 && i <= 2643)) return true;
  }
  if (g.titleNumbers.has(n)) return true;
  const tol = (v: number) => Math.max(half, Math.abs(v) * 0.005);
  return g.values.some((v) => Math.abs(v - n) <= tol(n) || (isPct && Math.abs(v * 100 - n) <= tol(n)));
}
