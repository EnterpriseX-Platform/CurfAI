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
import type { Report } from "@/lib/reporting/schema";

export type RuleId = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8" | "R9" | "R10" | "R11";

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
    check: "A horizontal bar, a grid heatmap and a table get the height their rows need (a full-width heatmap or table that is taller than that is shortened); a bar with more rows than fit even at the tallest size, or a pie with more than 8 slices, is flagged for the reviewer to limit.",
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
];

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
  return REPORT_RULES.map((r) => `- ${r.ai}`);
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
  fix?: { kind: "limit"; queryId: string; n: number } | { kind: "height"; h: number };
};

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
const TABLE_LINE_PX = 41;
const TABLE_CHROME_PX = 100;
/**
 * Grid rows for a table showing `rows` lines, so a list is read whole, not
 * scrolled inside its card (อบต. บ้านกลาง's "15 โครงการที่ล่าช้าที่สุด" showed
 * nine, 2026-10-03): its title and column header, then 41px a line.
 */
export function tableBlockHeight(rows = 20): number {
  return Math.min(24, Math.max(6, Math.ceil((TABLE_CHROME_PX + TABLE_LINE_PX * rows) / GRID_STEP_PX)));
}

/**
 * A wrapped cell's extra line, and a character's width in the table's own
 * font (a 34-character Thai product name wrapped in a 241px cell: ~6.5px).
 */
const TABLE_WRAP_PX = 20;
const TABLE_CHAR_PX = 6.6;
const TABLE_CELL_PAD_PX = 24;
/** The least a column takes: its header (Thai headers held number columns at 105–125px). */
const TABLE_COL_MIN_PX = 104;
/**
 * A full-width (12-column) table's width, in px, inside an app — where the
 * side panel narrows the report (measured 986px). A table that fits on its
 * own page can still wrap there.
 */
const FULL_WIDTH_PX = 980;
/**
 * Grid rows for a table showing these `rows`, each as tall as its text wraps
 * to — twenty product names that wrapped to two lines in an app still
 * scrolled in a card sized for one line each (Pet Lovers' "สินค้าขายดี 20
 * อันดับแรก", 2026-10-03). Columns are laid out the way a browser does: each
 * at its text's width while they all fit; when they don't, the longest-text
 * column gives up the difference and wraps. `w` is the block's grid width.
 */
export function tableHeightForRows(rows: Array<Record<string, unknown>>, columns: string[], w = 12): number {
  const width = (FULL_WIDTH_PX * Math.min(12, Math.max(1, w))) / 12;
  const textPx = (v: unknown) => String(v ?? "").length * TABLE_CHAR_PX;
  const natural = columns.map((c) => Math.max(TABLE_COL_MIN_PX, Math.max(0, ...rows.map((r) => textPx(r?.[c]))) + TABLE_CELL_PAD_PX));
  const excess = natural.reduce((a, b) => a + b, 0) - width;
  const widest = natural.indexOf(Math.max(...natural));
  const room = excess > 0 ? Math.max(140, natural[widest]! - excess) - TABLE_CELL_PAD_PX : Infinity;
  const linesPx = rows.reduce((sum, row) => {
    const lines = excess > 0 ? Math.ceil(textPx(row?.[columns[widest]!]) / room) : 1;
    return sum + TABLE_LINE_PX + (Math.min(Math.max(lines, 1), 3) - 1) * TABLE_WRAP_PX;
  }, 0);
  return Math.min(24, Math.max(6, Math.ceil((TABLE_CHROME_PX + linesPx) / GRID_STEP_PX)));
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
function itemFor(sql: string, alias: string): string | null {
  const cteEnd = sql.search(/\)\s*select\b/i);
  const items = selectItems(cteEnd >= 0 ? sql.slice(cteEnd + 1) : sql);
  const aliasRe = new RegExp(`\\bas\\s+"?${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\s*$`, "i");
  return items.find((i) => aliasRe.test(i)) ?? null;
}

function aggregateOf(item: string): string | null {
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
    // A grid heatmap and a table are sized to the rows they show. Too short
    // grows; too tall shrinks only at full width — a half-width block's row
    // partner may still need the height.
    const fitted = rows.length === 0 ? null
      : b.type === "heatmap" && cfg.mode === "grid" && typeof cfg.yField === "string"
        ? { h: gridHeatmapHeight(new Set(rows.map((r) => String(r?.[cfg.yField] ?? "—"))).size), what: "rows of cells" }
      : b.type === "table"
        ? {
          h: tableHeightForRows(
            rows.slice(0, typeof cfg.pageSize === "number" && cfg.pageSize > 0 ? cfg.pageSize : 20),
            Array.isArray(cfg.columns) && cfg.columns.length ? cfg.columns.map((c: any) => String(c?.key ?? c)) : Object.keys(rows[0] ?? {}),
            b.w,
          ),
          what: "lines",
        }
      : null;
    if (fitted && (b.h < fitted.h || (b.h > fitted.h && b.w >= 12))) {
      const name = cfg.title ?? b.id;
      out.push({ rule: "R6", target: b.id, detail: `"${name}" is ${b.h < fitted.h ? "too short" : "too tall"} for its ${fitted.what}`, fix: { kind: "height", h: fitted.h } });
    }
  }

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
  }
  return out;
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
