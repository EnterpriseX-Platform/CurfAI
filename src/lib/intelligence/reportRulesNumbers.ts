/**
 * The checks of rules R12-R18 (reportRules.ts lists the rules; this is what
 * code looks at): what a report's own numbers and words say about each other.
 * A KPI that states its target but holds no plan, a value field called
 * `2569_100`, a "cumulative" line that runs backwards because the query sorts
 * by its measure, a title that names a fiscal year the SQL never filters to, a
 * share above 100%, a column of unrounded decimals, a KPI with no rows behind
 * it. Where the repair is mechanical the violation carries it (`fix`), and
 * `applyRuleFix` is the one function that carries it out — the report gate and
 * the verify-and-repair loop (master-builder/verify) both call it.
 *
 * Pure: no server imports.
 */
import type { Report } from "@/lib/reporting/schema";
import { computeKpiValue } from "@/lib/reporting/kpi";
import { aggregateOf, itemFor, type Dataset, type RuleId } from "./reportRules";
import { caseConditions, deriveDetailSql, findTop, splitWith } from "./drillQuery";
import { askFor, kpiVariants, parseTargetText, type KpiAsk } from "./kpiMatch";
import { neededQueries } from "@/lib/reporting/queryRefs";

type Row = Record<string, unknown>;
type Block = Report["pages"][number]["blocks"][number];

export type NumberRuleFix =
  | { kind: "plan"; blockId: string; plan: number; lowerIsBetter: boolean }
  | { kind: "column-format"; blockId: string; columns: Array<{ key: string; type: "number" | "percent"; format?: string }> }
  | { kind: "order"; queryId: string; sql: string }
  | { kind: "rename-field"; queryId: string; blockId: string; from: string; to: string }
  | { kind: "drill"; blockId: string; queryId: string }
  /** A drill-down with a query of its own: the KPI's rows, written from the KPI's SQL (drillQuery.ts). */
  | { kind: "drill-new"; blockId: string; queryId: string; dataSourceId: string; name: string; sql: string }
  /** R24: the card repeats `keepId`'s expression. It goes; what it had that the kept card lacks moves over. */
  | { kind: "drop-duplicate"; blockId: string; keepId: string }
  /** R25: the unit phrase in the label names a scale the number does not have. */
  | { kind: "strip-unit"; blockId: string }
  /** R26: the KPI averaged a rate column; its query now divides the summed parts (`sql` is the whole new query). */
  | { kind: "weighted-ratio"; blockId: string; queryId: string; sql: string }
  /** R19: a share the query already multiplied by 100 (21.56) printed as a percent (2,156%): shown as a number with a % sign. */
  | { kind: "percent-points"; blockId: string }
  /** R27: the card's own column filters to a year next to the one its label names, and has no value there: that column filters to the label's year. */
  | { kind: "year-literal"; blockId: string; queryId: string; valueField: string; from: number; to: number; relabel?: { from: string; to: string } };

/** The numerator and denominator columns a rate column is made of, found by probing the table's rows (rateParts.ts). `numeratorPlus`: the numerator is two columns added (arrears past two years = the 2-3 year and the over-3 year bands). `points`: the rate is stored 0-100, not 0-1. */
export type RateParts = { numerator: string; numeratorPlus?: string; denominator: string; points: boolean };

export type NumberViolation = {
  rule: RuleId; target: string; detail: string; fix?: NumberRuleFix;
  /** A note for the verifier and the repair brief, not for the report's reader: the gate does not flag it. */
  info?: boolean;
  /** R26 with no fix yet: the table and rate column whose numerator and denominator the gate should look for (rateParts.ts). */
  probe?: { table: string; column: string };
};

const queryOf = (b: { config?: unknown }): string | null => {
  const q = (b as any).config?.queryId;
  return typeof q === "string" ? q : null;
};
const titleOf = (b: Block): string => {
  const c = (b as any).config ?? {};
  return String(c.title ?? c.label ?? c.text ?? `${b.type} ${b.id}`);
};

// ── SQL reading ─────────────────────────────────────────────────────────

/** Positions of the outermost ORDER BY and LIMIT of a query (depth 0, outside quotes), or null parts. */
export function topLevelClauses(sql: string): { orderAt: number | null; orderEnd: number; limitAt: number | null; end: number; hasGroupBy: boolean } {
  let depth = 0, quote: string | null = null, orderAt: number | null = null, limitAt: number | null = null, groupBy = false;
  let end = sql.length;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "(") { depth++; continue; }
    if (ch === ")") { depth--; continue; }
    if (ch === ";" && depth === 0) { end = i; break; }
    if (depth !== 0 || !/[A-Za-z]/.test(ch) || (i > 0 && /[\w"]/.test(sql[i - 1]!))) continue;
    const rest = sql.slice(i);
    if (/^order\s+by\b/i.test(rest)) { orderAt = i; limitAt = null; }
    else if (/^limit\b/i.test(rest) && orderAt !== null && limitAt === null) limitAt = i;
    else if (/^limit\b/i.test(rest) && orderAt === null && limitAt === null) limitAt = i;
    else if (/^group\s+by\b/i.test(rest)) groupBy = true;
  }
  return { orderAt, orderEnd: limitAt ?? end, limitAt, end, hasGroupBy: groupBy };
}

const SQL_WORDS = new Set(["asc", "desc", "nulls", "first", "last", "cast", "as", "double", "varchar", "integer", "min", "max", "avg", "sum", "count", "coalesce", "date", "numeric", "int", "bigint", "decimal", "float", "real", "text"]);

/** The column names in the first key of an ORDER BY list (quoted names first, else bare words). */
function firstOrderKeyColumns(sql: string, c: ReturnType<typeof topLevelClauses>): string[] {
  if (c.orderAt === null) return [];
  const body = sql.slice(c.orderAt, c.orderEnd).replace(/^order\s+by\s+/i, "");
  let depth = 0, cut = body.length;
  for (let i = 0; i < body.length; i++) { const ch = body[i]; if (ch === "(") depth++; else if (ch === ")") depth--; else if (ch === "," && depth === 0) { cut = i; break; } }
  const key = body.slice(0, cut);
  const quoted = [...key.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  if (quoted.length) return quoted;
  return (key.match(/[A-Za-z_][\w]*/g) ?? []).filter((w) => !SQL_WORDS.has(w.toLowerCase()));
}

/** Tables a query reads, by bare name (schema prefix and quotes dropped). */
export function tablesRead(sql: string): string[] {
  return [...new Set([...sql.matchAll(/\b(?:from|join)\s+(?:"?\w+"?\.)?"?([\p{L}\w]+)"?/giu)].map((m) => m[1]!))];
}

// ── Naming ──────────────────────────────────────────────────────────────

const TIME_NAME = /(^|_)(month|mth|period|date|day|week|quarter|qtr|year|fy|fiscal|time|ym|yyyymm)(_|$)|เดือน|ปี|ไตรมาส|วัน|สัปดาห์|งวด|年|月|季|周/i;
const ORDINAL_NAME = /^(?:fiscal_)?(?:month|mth|period|quarter|qtr|week|day|year)_?(?:no|num|number|order|seq|index|idx)$|^(?:month|period)_(?:of_year|in_fy)$/i;
const CUMULATIVE = /cumul|running|ytd|สะสม|累计|累積/i;
const YEAR_COLUMN = /^(?:fiscal_year|fy|year|yr|budget_year|reserve_fy|fy_year|ปีงบประมาณ)$|(?:^|_)(?:fiscal_year|fy)$/i;
/** "2567–2569": a title that spans years says so. */
const YEAR_RANGE = /(?:25|20)\d\d\s*[–—-]\s*(?:25|20)?\d\d/;
const MULTI_YEAR_WORDS = /หลายปี|ทุกปี|ทั้งหมด|รายปี|ย้อนหลัง|แนวโน้ม|multiple (?:fiscal )?years|all years|each year|by (?:fiscal )?year|per year|trend|annual|yearly|over time|多年|历年|各年/i;

// ── R12: a target in the label is the KPI's plan ────────────────────────

const LOWER_OPS = /^(?:≤|<=|<|ไม่เกิน|ต่ำกว่า|at most|not exceeding|no more than|up to|under|max\.?)$/i;
const TARGET_RE = /(?:target(?:\s+of)?|เป้าหมาย|เป้า|目标|目標)\s*[:：=]?\s*(≥|≤|>=|<=|>|<|ไม่เกิน|ไม่น้อยกว่า|ไม่ต่ำกว่า|อย่างน้อย|ต่ำกว่า|at least|at most|not exceeding|no more than|up to|under|over|min\.?|max\.?)?\s*(?:ร้อยละ\s*)?(\d+(?:\.\d+)?)\s*(%|เปอร์เซ็นต์|percent|ร้อยละ)?/i;
const BRACKET_TARGET_RE = /[(（]\s*(≥|≤|>=|<=)\s*(\d+(?:\.\d+)?)\s*(%)?\s*[)）]/;

/** The target a label states ("(เป้าหมาย ≤ 35%)", "target: 8%"): its number, the unit it is written in and the direction. */
export function targetFromLabel(label: string): { value: number; percent: boolean; lowerIsBetter: boolean } | null {
  const m = TARGET_RE.exec(label) ?? BRACKET_TARGET_RE.exec(label);
  if (!m) return null;
  const value = Number(m[2]);
  if (!Number.isFinite(value)) return null;
  return { value, percent: !!m[3], lowerIsBetter: LOWER_OPS.test((m[1] ?? "").trim()) };
}

// ── R14: time runs forward ──────────────────────────────────────────────

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** What the ORDER BY of a time-axis query should be, or null when no safe key exists. */
function timeOrderKey(sql: string, x: string, tableColumns: Record<string, string[]> | undefined, rows: Row[], hasGroupBy: boolean): string | null {
  const cols = tablesRead(sql).flatMap((t) => tableColumns?.[t] ?? []);
  const own = cols.find((c) => ORDINAL_NAME.test(c));
  if (ORDINAL_NAME.test(x)) return `"${x}"`;
  if (own) return hasGroupBy ? `MIN(CAST("${own}" AS DOUBLE))` : `"${own}"`;
  const sample = rows.map((r) => r[x]).filter((v) => v != null);
  const sortable = sample.length > 0 && sample.every((v) => typeof v === "number" || /^\d{4}(?:-\d{2}(?:-\d{2})?)?(?:[ T].*)?$/.test(String(v)));
  return TIME_NAME.test(x) && sortable ? `"${x}"` : null;
}

function withOrder(sql: string, key: string): string {
  const c = topLevelClauses(sql);
  const head = sql.slice(0, c.orderAt ?? c.limitAt ?? c.end).replace(/\s+$/, "");
  const tail = c.limitAt !== null ? " " + sql.slice(c.limitAt, c.end).trim() : "";
  return `${head} ORDER BY ${key}${tail}`;
}

/** What rows a query keeps: its WHERE without the report-parameter guards ((:f = '' OR ...)) and the composer's IS NOT NULL. */
function whereKey(sql: string): string {
  const m = /\bwhere\b([\s\S]*?)(?:\bgroup\s+by\b|\border\s+by\b|\blimit\b|;|$)/i.exec(sql);
  return (m?.[1] ?? "").replace(/\(\s*:\w+\s*=\s*''\s*OR[^)]*\)/gi, "").replace(/"[^"]+"\s+is\s+not\s+null/gi, "").replace(/\band\b/gi, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

// ── R15: the year a label names ─────────────────────────────────────────

const STATED_YEAR = /(?:FY\s?|fiscal year\s?|ปีงบประมาณ\s?|ปีงบ\s?|ปี\s?|ปีภาษี\s?|年度\s?|财年\s?)((?:25|20)\d\d)/i;

// ── R19: an amount read as a share ──────────────────────────────────────

/** A calculation that leaked into the words ("(divided by 100)", "÷ 100", "หาร 100"). */
const LEAKED_CALC = /\bdivided by\b|\bmultiplied by\b|÷\s*\d|หารด้วย|หาร\s*\d|คูณด้วย|除以|乘以/i;
/** A word in a label that narrows what a ratio covers, and what the query must hold to apply it. */
const SCOPE_WORDS: Array<{ name: string; label: RegExp; sql: RegExp }> = [
  { name: "investment", label: /ลงทุน|\binvestment\b|\bcapital\b|资本|投资/i, sql: /ลงทุน|investment|capital|资本|投资/i },
  { name: "operating spend", label: /รายจ่ายประจำ|งบประจำ|\boperating\b|\brecurrent\b|经常/i, sql: /ประจำ|operating|recurrent|经常/i },
];
const fmtPercent = (fraction: number): string => `${Number((fraction * 100).toPrecision(6)).toLocaleString("en-US")}%`;

// ── R24 / R25: what a KPI card's number is, and what its label says it is ─────

type KpiExpression = { id: string; key: string; label: string; cfg: any; block: Block };

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** What makes two KPI cards the same number: the select item of the value (alias aside), its aggregate and format, and the rest of the query. */
function kpiExpressions(b: Block, label: string, vf: string, cfg: any, sql: string, out: KpiExpression[]): void {
  const item = vf ? itemFor(sql, vf) : null;
  if (!item) return;
  const expr = squash(item.replace(/\s+as\s+"?[^"]+"?\s*$/i, ""));
  const rest = squash(sql.replace(item, ""));
  out.push({ id: b.id, label, cfg, block: b, key: `${expr}|${cfg.aggregate ?? ""}|${cfg.format ?? ""}|${rest}` });
}

/** The brief's KPI a card's own words name. Words only: two cards on one governed metric share its key and column, which would name both. */
const askedAs = (k: KpiExpression, asks: KpiAsk[]): KpiAsk | null =>
  askFor(kpiVariants({ config: { label: k.cfg.label }, i18n: (k.block as any).i18n }), asks);

/** Which of two cards that repeat each other stays: a governed one, one with more behind it, one the brief named, the first on the page. */
function keepOf(group: KpiExpression[], order: Map<string, number>, asks: KpiAsk[] | undefined): KpiExpression {
  const weight = (k: KpiExpression) =>
    (k.cfg.metricKey ? 8 : 0) + (k.cfg.plan != null || k.cfg.planField ? 4 : 0) + (k.cfg.drilldown ? 2 : 0) + (k.cfg.sparkQueryId ? 1 : 0)
    + (asks?.length && askedAs(k, asks) ? 16 : 0);
  return [...group].sort((a, b) => weight(b) - weight(a) || (order.get(a.id)! - order.get(b.id)!))[0]!;
}

/** R24 over the KPIs the loop collected: groups of two or more cards with one expression. */
function duplicateKpis(report: Report, kpis: KpiExpression[], asks: KpiAsk[] | undefined): NumberViolation[] {
  const groups = new Map<string, KpiExpression[]>();
  for (const k of kpis) groups.set(k.key, [...(groups.get(k.key) ?? []), k]);
  const order = new Map(report.pages.flatMap((p) => p.blocks).sort((a, b) => a.y - b.y || a.x - b.x).map((b, i) => [b.id, i] as const));
  const json = JSON.stringify(report);
  const out: NumberViolation[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keep = keepOf(group, order, asks);
    for (const dup of group) {
      if (dup === keep) continue;
      // Two cards the brief named separately are two asks, not one repeated: flagged, never dropped (briefCompletion's rule).
      const dupAsk = asks?.length ? askedAs(dup, asks) : null;
      const keepAsk = asks?.length ? askedAs(keep, asks) : null;
      const bothAsked = !!dupAsk && !!keepAsk && dupAsk !== keepAsk;
      // A What-if input or a reading elsewhere that names the card by id: it stays.
      const referenced = json.split(`"${dup.id}"`).length - 1 > 1;
      out.push({
        rule: "R24", target: dup.id,
        detail: `"${dup.label || dup.id}" shows the same number as "${keep.label || keep.id}" (one expression, one format)`,
        ...(bothAsked || referenced ? {} : { fix: { kind: "drop-duplicate" as const, blockId: dup.id, keepId: keep.id } }),
      });
    }
  }
  return out;
}

/** The scale a unit phrase in a label names, and the phrase. Thai, English and Chinese forms of "in hundreds / thousands / millions of baht". */
const UNIT_PHRASES: Array<{ re: RegExp; scale: number }> = [
  { re: /\(?\s*(?:หน่วย\s*[:：]?\s*)?ร้อยบาท\s*\)?/, scale: 100 },
  { re: /\(?\s*(?:หน่วย\s*[:：]?\s*)?พันบาท\s*\)?/, scale: 1e3 },
  { re: /\(?\s*(?:หน่วย\s*[:：]?\s*)?หมื่นบาท\s*\)?/, scale: 1e4 },
  { re: /\(?\s*(?:หน่วย\s*[:：]?\s*)?แสนบาท\s*\)?/, scale: 1e5 },
  { re: /\(?\s*(?:หน่วย\s*[:：]?\s*)?ล้านบาท\s*\)?/, scale: 1e6 },
  { re: /\(\s*(?:in\s+)?hundreds?(?:\s+of)?(?:\s+(?:baht|thb))?\s*\)/i, scale: 100 },
  { re: /\(\s*(?:in\s+)?thousands?(?:\s+of)?(?:\s+(?:baht|thb))?\s*\)/i, scale: 1e3 },
  { re: /\(\s*(?:in\s+)?millions?(?:\s+of)?(?:\s+(?:baht|thb))?\s*\)/i, scale: 1e6 },
  { re: /\(\s*(?:in\s+)?billions?(?:\s+of)?(?:\s+(?:baht|thb))?\s*\)/i, scale: 1e9 },
  { re: /[（(]\s*(?:单位[:：]?\s*)?(?:百万|万|千)元\s*[）)]/, scale: 0 },
];

function unitOfLabel(label: string): { phrase: string; scale: number } | null {
  for (const u of UNIT_PHRASES) {
    const m = u.re.exec(label);
    if (!m) continue;
    const zh = /百万|万|千/.exec(m[0]);
    const scale = u.scale || (zh ? (zh[0] === "百万" ? 1e6 : zh[0] === "万" ? 1e4 : 1e3) : 0);
    return { phrase: m[0], scale };
  }
  return null;
}

/** What the value's select item divides by (`/ 100.0`, `/1000000`): 1 when it is the figure as stored. */
function divisorOf(item: string | null): number {
  if (!item) return 1;
  const all = [...item.matchAll(/\/\s*(\d+(?:\.\d+)?|1e\d)\b/gi)].map((m) => Number(m[1]));
  const scale = all.find((n) => [10, 100, 1e3, 1e4, 1e5, 1e6, 1e9].includes(n));
  return scale ?? 1;
}

const AMOUNT_WORDS = /ยอดเงิน|จำนวนเงิน|วงเงิน|งบประมาณ|บาท|\bbaht\b|\bamount\b|\bbudget\b|\bspend(?:ing)?\b|\brevenue\b|金额|预算|元/i;
const COUNT_WORDS = /จำนวน(?!เงิน)|โครงการ|\bราย\b|แห่ง|รายการ|\bcounts?\b|number of|\bprojects?\b|\brows?\b|\bitems?\b|\bcases?\b|ไม่ซ้ำ|个|项目数|数量|笔/i;

/** R25: a label that names a unit the number does not have, or an amount over a count. */
function unitViolations(b: Block, label: string, vf: string, cfg: any, sql: string): NumberViolation[] {
  if (!label || !vf || cfg.format === "percent") return [];
  const item = itemFor(sql, vf);
  const out: NumberViolation[] = [];
  const unit = unitOfLabel(label);
  // A governed metric is in baht by definition, whatever the card the model drew.
  const divisor = cfg.metricKey ? 1 : divisorOf(item);
  const aggregate = item ? aggregateOf(item) : (cfg.aggregate ? String(cfg.aggregate).toUpperCase() : null);
  if (unit && unit.scale !== divisor) {
    out.push({
      rule: "R25", target: b.id,
      detail: `"${label}" says ${unit.phrase.replace(/[()（）]/g, "").trim()}, but the number is ${divisor === 1 ? "in baht, not scaled" : `divided by ${divisor}`}`,
      // The number is what it is; a unit it does not have comes off the label. A different scale in the query is for the repair brief.
      // (Not over a count: there the column is the mistake, and a label with its unit gone would still name an amount.)
      ...(divisor === 1 && aggregate !== "COUNT" ? { fix: { kind: "strip-unit" as const, blockId: b.id } } : {}),
    });
  }
  if (aggregate === "COUNT" && AMOUNT_WORDS.test(label) && !COUNT_WORDS.test(label)) {
    out.push({ rule: "R25", target: b.id, detail: `"${label}" names an amount, but the number is a count of rows (${vf})` });
  }
  return out;
}

// ── R26: an average of rates is not the rate ──────────────────────────────────

/** A column that holds a rate, share or percent per row (collection_rate_pct, vacancy_share). */
const RATE_COLUMN = /(?:^|_)(?:pct|percent|percentage|rate|ratio|share)(?:_|$)|^(?:สัดส่วน|อัตรา|ร้อยละ)/i;
const RATE_SQL_WORDS = new Set(["case", "when", "then", "else", "end", "cast", "as", "double", "and", "or", "is", "not", "null", "in", "between", "like", "decimal", "float", "real", "numeric", "integer", "int", "varchar", "text", "coalesce", "nullif", "abs"]);

/** Every `AVG( ... )` call of a select item: where it sits and what it averages. */
export function avgCalls(item: string): Array<{ start: number; end: number; inner: string }> {
  const out: Array<{ start: number; end: number; inner: string }> = [];
  const re = /\bAVG\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(item))) {
    let depth = 1, quote: string | null = null, i = m.index + m[0].length;
    for (; i < item.length; i++) {
      const ch = item[i]!;
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) break;
    }
    if (depth === 0) out.push({ start: m.index, end: i + 1, inner: item.slice(m.index + m[0].length, i) });
  }
  return out;
}

/** The rate column an AVG averages, if its inner expression reads one (among `known` columns when they are known). */
export function averagedRateColumn(inner: string, known?: string[]): string | null {
  const names = [...inner.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  const bare = inner.replace(/"[^"]*"|'[^']*'/g, " ");
  names.push(...[...bare.matchAll(/\b([A-Za-z_]\w*)\b/g)].map((m) => m[1]!).filter((w) => !RATE_SQL_WORDS.has(w.toLowerCase())));
  return names.find((n) => RATE_COLUMN.test(n) && (!known || known.includes(n))) ?? null;
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const swapColumn = (expr: string, from: string, to: string) =>
  expr.replace(new RegExp(`"${escRe(from)}"|(?<![\\w"])${escRe(from)}(?![\\w"])`, "g"), () => to);
const quoted = (c: string) => `"${c}"`;

/**
 * The query with `AVG(expr over the rate)` replaced by `SUM(expr over the numerator) / NULLIF(SUM(expr over the
 * denominator), 0)`: the overall rate, each row counted by its size. A rate stored in points was divided by 100 right
 * after the AVG to make a fraction; the division goes (the ratio is the fraction), and a rate kept in points stays in points.
 */
export function weightedRatioSql(sql: string, item: string, rate: string, parts: RateParts): string | null {
  const calls = avgCalls(item).filter((c) => averagedRateColumn(c.inner) === rate);
  if (calls.length !== 1) return null;
  const c = calls[0]!;
  const top = parts.numeratorPlus ? `(COALESCE(${quoted(parts.numerator)}, 0) + COALESCE(${quoted(parts.numeratorPlus)}, 0))` : quoted(parts.numerator);
  const ratio = `(SUM(${swapColumn(c.inner, rate, top)}) * 1.0 / NULLIF(SUM(${swapColumn(c.inner, rate, quoted(parts.denominator))}), 0))`;
  const after = item.slice(c.end);
  const div = /^\s*\/\s*100(?:\.0+)?(?![\d.])/.exec(after);
  let next: string;
  if (parts.points) next = div ? item.slice(0, c.start) + ratio + after.slice(div[0].length) : item.slice(0, c.start) + `(${ratio} * 100.0)` + after;
  else if (div) return null;
  else next = item.slice(0, c.start) + ratio + after;
  return sql.includes(item) ? sql.replace(item, () => next) : null;
}

/** The query that tells which two columns of `table` a rate column is the ratio of (rateParts.ts reads its one row). */
export function rateProbeSql(table: string, rate: string, numeric: string[], plus = false): { sql: string; pairs: Array<[string, string, string?]> } {
  const q = (c: string) => `"${c.replace(/"/g, '""')}"`;
  // The columns that share words with the rate's name come first (arrears_over_2y_pct: the arrears_* columns), so the
  // cap cuts the least likely ones, not whatever sits last in the table (the age bands were column 15+ of 22).
  const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !/^(pct|percent|percentage|rate|ratio|share|of|to|vs|baht|total)$/.test(w));
  const wanted = new Set(words(rate));
  const overlap = (c: string) => words(c).filter((w) => wanted.has(w)).length;
  const cols = numeric
    .filter((c) => c !== rate && !RATE_COLUMN.test(c) && !/(^|_)(id|no|code|year|fy|month|quarter|rank|seq)(_|$)/i.test(c))
    .map((c, i) => ({ c, i, o: overlap(c) }))
    .sort((a, b) => b.o - a.o || a.i - b.i)
    .map((x) => x.c)
    .slice(0, plus ? 12 : 40);
  const pairs: Array<[string, string, string?]> = [];
  const items: string[] = [];
  const add = (top: string, n: string, d: string, n2?: string) => {
    const i = pairs.length;
    pairs.push(n2 ? [n, d, n2] : [n, d]);
    const ratio = `${top} / NULLIF(CAST(${q(d)} AS DOUBLE), 0)`;
    items.push(`MAX(ABS(${ratio} - CAST(${q(rate)} AS DOUBLE))) AS e1_${i}`, `MAX(ABS(${ratio} * 100.0 - CAST(${q(rate)} AS DOUBLE))) AS e100_${i}`);
  };
  // `plus`: a numerator of two columns added (the second probe, run only when no single column reproduced the rate).
  if (plus) {
    for (let a = 0; a < cols.length; a++) for (let b = a + 1; b < cols.length; b++) for (const d of cols) {
      if (d === cols[a] || d === cols[b]) continue;
      add(`(COALESCE(CAST(${q(cols[a]!)} AS DOUBLE), 0) + COALESCE(CAST(${q(cols[b]!)} AS DOUBLE), 0))`, cols[a]!, d, cols[b]!);
    }
  } else {
    for (const n of cols) for (const d of cols) if (n !== d) add(`CAST(${q(n)} AS DOUBLE)`, n, d);
  }
  return { sql: `SELECT COUNT(*) AS n, MAX(CAST(${q(rate)} AS DOUBLE)) AS rate_max${items.length ? ", " + items.join(", ") : ""} FROM ${q(table)} WHERE ${q(rate)} IS NOT NULL`, pairs };
}

/** The pair the probe's row names: the smallest worst-case error, within the rate's own rounding. */
export function pickRateParts(row: Record<string, unknown>, pairs: Array<[string, string, string?]>): RateParts | null {
  const n = Number(row.n), max = Number(row.rate_max);
  if (!(n >= 5) || !Number.isFinite(max)) return null;
  const points = max > 1.5;
  let best: { i: number; err: number } | null = null;
  pairs.forEach((_, i) => {
    const err = Number(row[`${points ? "e100" : "e1"}_${i}`]);
    if (Number.isFinite(err) && (!best || err < best.err)) best = { i, err };
  });
  const b = best as { i: number; err: number } | null;
  // Rates are stored rounded: half a point (half a hundredth of a fraction) is the tolerance.
  if (!b || b.err > (points ? 0.5 : 0.005)) return null;
  const [numerator, denominator, numeratorPlus] = pairs[b.i]!;
  return { numerator, denominator, ...(numeratorPlus ? { numeratorPlus } : {}), points };
}

/** R26 for one KPI: its value is an average of a rate column. */
function avgRateViolations(b: Block, label: string, vf: string, cfg: any, sql: string, qid: string, opts: { tableColumns?: Record<string, string[]>; rateParts?: Record<string, RateParts> }): NumberViolation[] {
  if (!vf || cfg.metricKey) return [];
  if (!(cfg.format === "percent" || SHARE_LABEL.test(label) || /pct|percent|rate|share/i.test(vf))) return [];
  const item = itemFor(sql, vf);
  if (!item) return [];
  const tables = tablesRead(sql);
  const known = tables.flatMap((t) => opts.tableColumns?.[t] ?? []);
  const rate = avgCalls(item).map((c) => averagedRateColumn(c.inner, known.length ? known : undefined)).find((r): r is string => !!r);
  if (!rate) return [];
  const table = tables.length === 1 ? tables[0]! : tables.find((t) => opts.tableColumns?.[t]?.includes(rate));
  const detail = `"${label || b.id}" averages ${rate}, a rate per row: the overall rate counts each row by its size (the sum of its parts over the sum of the whole)`;
  const parts = table ? opts.rateParts?.[`${table}.${rate}`] : undefined;
  // Only this select item changes, under its own alias: the other cards of a shared query read other items.
  const fixed = parts ? weightedRatioSql(sql, item, rate, parts) : null;
  if (fixed) return [{ rule: "R26", target: b.id, detail, fix: { kind: "weighted-ratio", blockId: b.id, queryId: qid, sql: fixed } }];
  return [{ rule: "R26", target: b.id, detail, ...(table && !parts ? { probe: { table, column: rate } } : {}) }];
}

// ── R28: a card that says rate shows an amount ────────────────────────────────

/** A label that promises a rate or a share (not a change: "growth rate" is another thing). */
const RATE_LABEL = /\b(?:rate|share|ratio)\b|อัตรา|สัดส่วน|ร้อยละ|占比|比例|比率|完成率/i;

/** The query's text with its quoted names and strings blanked, so a `/` left in it is a division. */
const sqlDivides = (sql: string) => /\//.test(sql.replace(/'[^']*'|"[^"]*"/g, " ").replace(/\/\*[\s\S]*?\*\//g, " "));

/**
 * R28 for one KPI: the label says rate/share but the card prints an amount: money, or a count above 100, from a query that never divides
 * (a planner that wrote "current collection rate" as two SUM columns and read the numerator: 167M under a rate label).
 */
function rateLabelViolations(b: Block, label: string, cfg: any, sql: string, shown: number): NumberViolation[] {
  if (cfg.metricKey || cfg.format === "percent" || !Number.isFinite(shown)) return [];
  if (!RATE_LABEL.test(label) || CHANGE_LABEL.test(label) || sqlDivides(sql)) return [];
  if (!(cfg.format === "currency" || Math.abs(shown) > 100)) return [];
  return [{ rule: "R28", target: b.id, detail: `"${label}" is labelled a rate or share, but it shows ${Number(shown.toPrecision(6))} and its query never divides one amount by another` }];
}

// ── R34: a percent card beyond any percent a reader can believe ───────────────

/** A percent card holds a ratio (0.18 prints 18%); past 10 it prints more than 1000%, the bound R30 sets for prose. */
export const PERCENT_CARD_MAX_RATIO = 10;

/** R34 for one KPI: formatted as a percent, but the value is a ratio no one can believe (SUM(paid_baht) / 100 printed 18,504,032%). */
function percentCardViolations(b: Block, label: string, cfg: any, shown: number): NumberViolation[] {
  if (cfg.format !== "percent" || !Number.isFinite(shown) || Math.abs(shown) <= PERCENT_CARD_MAX_RATIO) return [];
  return [{ rule: "R34", target: b.id, detail: `"${label || b.id}" is a percent but would print ${Math.round(shown * 100).toLocaleString("en-US")}%, past any share or rate a reader can believe` }];
}

// ── The detection ───────────────────────────────────────────────────────

/** A year as it is written, in the Buddhist era. */
const asBuddhist = (y: number) => (y < 2400 ? y + 543 : y);

/**
 * R27: the select item that makes the card's value filters to a year (`CASE WHEN fiscal_year = 2570 ...`) and the label names the year
 * next to it (FY2569). The year it filters to, and the one to filter to instead, in the era the query writes; null when the item
 * names no year, names more than one, or names a year that is not next to the label's.
 */
export function yearLiteralSwap(label: string, valueField: string, sql: string): { from: number; to: number } | null {
  const year = STATED_YEAR.exec(label)?.[1];
  const item = valueField ? itemFor(sql, valueField) : null;
  if (!year || !item) return null;
  const from = onlyYearLiteral(item), want = Number(year);
  if (from === null) return null;
  if (Math.abs(asBuddhist(from) - asBuddhist(want)) !== 1) return null;
  const to = from >= 2400 === want >= 2400 ? want : from >= 2400 ? want + 543 : want - 543;
  return { from, to };
}

/** The one year a select item filters to (`... fiscal_year = 2570 ...`), or null when it names none or several. */
function onlyYearLiteral(item: string): number | null {
  const literals = [...new Set([...item.matchAll(/=\s*((?:25|20)\d\d)(?!\d)/g)].map((m) => Number(m[1])))];
  return literals.length === 1 ? literals[0]! : null;
}

/**
 * R27: the label names a year (FY2570) and the card's own column filters to that same year, and the card has no value: the year has no
 * data yet (an estimate being drafted, a month not closed). The card moves to the year before it, in the query AND in its words, so what it
 * says is what it shows; the gate keeps it only if the card then shows a number (reportGate.ts), and otherwise puts it back. Found on the
 * municipality demo (bench-14, 2026-10-18): a Spending report built on FY2570 had every card empty, and the build lost the tab.
 */
export function yearFallbackSwap(label: string, valueField: string, sql: string): { from: number; to: number; relabel: { from: string; to: string } } | null {
  const year = STATED_YEAR.exec(label)?.[1];
  const item = valueField ? itemFor(sql, valueField) : null;
  if (!year || !item) return null;
  const from = onlyYearLiteral(item);
  if (from === null || from !== Number(year)) return null; // the query names the year the label names
  return { from, to: from - 1, relabel: { from: year, to: String(Number(year) - 1) } };
}

const SHARE_LABEL = /share|ratio|rate|สัดส่วน|อัตรา|ร้อยละ|เปอร์เซ็นต์|% of|percent of|completion|achievement|progress|ความคืบหน้า|占比|比例|比率|完成率/i;
const CHANGE_LABEL = /growth|change|yoy|mom|increase|decrease|เติบโต|เปลี่ยนแปลง|เพิ่มขึ้น|ลดลง|增长|变化|同比|环比/i;

export function detectNumberRules(
  report: Report, dataset: Dataset,
  opts: {
    tableColumns?: Record<string, string[]>;
    /** The KPIs the brief named, with the target it gave each: a KPI that is one of them and holds no plan gets that target (R12). */
    kpiAsks?: KpiAsk[];
    /** R26: the numerator and denominator of the rate columns the gate probed, by "table.column". */
    rateParts?: Record<string, RateParts>;
  } = {},
): NumberViolation[] {
  const out: NumberViolation[] = [];
  const blocks = report.pages.flatMap((p) => p.blocks);
  const sqlById = new Map(report.dataSources.map((d) => [d.id, d.sql ?? ""]));
  const paramNames = new Set((report.parameters ?? []).map((p) => p.name));
  const usersOf = new Map<string, number>();
  for (const b of blocks) { const q = queryOf(b); if (q) usersOf.set(q, (usersOf.get(q) ?? 0) + 1); }
  const named = new Map<string, Set<string>>();
  const kpis: KpiExpression[] = [];

  for (const b of blocks) {
    const cfg = (b as any).config ?? {};
    const qid = queryOf(b);
    if (!qid) continue;
    const sql = sqlById.get(qid) ?? "";
    const rows = dataset[qid] ?? [];

    if (b.type === "kpi") {
      const label = typeof cfg.label === "string" ? cfg.label : "";

      // R12 — a target in the words, no plan on the card.
      const labelTarget = label && cfg.plan == null && !cfg.planField ? targetFromLabel(label) : null;
      if (labelTarget) {
        const t = labelTarget;
        // A rate or a plain number takes the target as it is written; money with a target "of the base" needs a plan column, which code cannot invent.
        const fixable = cfg.format === "percent" || (cfg.format === "number" && !/\s(?:ของ|of)\s/i.test(label.slice(label.search(TARGET_RE))));
        out.push({
          rule: "R12", target: b.id, detail: `"${label}" states a target of ${t.value}${t.percent ? "%" : ""} but the KPI has no plan`,
          ...(fixable ? { fix: { kind: "plan" as const, blockId: b.id, plan: cfg.format === "percent" ? t.value / 100 : t.value, lowerIsBetter: t.lowerIsBetter } } : {}),
        });
      } else if (cfg.plan == null && !cfg.planField && opts.kpiAsks?.length) {
        // The brief's target for this KPI, when the label states none: matched by name (kpiMatch.ts), applied only
        // where the unit agrees (a rate target on a percent KPI, a plain target on a number: never "5%" on a baht total).
        // The best match among ALL the asks, then its target if it has one: a KPI whose ask has none keeps none.
        const ask = askFor(kpiVariants(b), opts.kpiAsks);
        const t = ask?.target ? parseTargetText(ask.target) : null;
        if (ask && t && ((t.percent && cfg.format === "percent") || (!t.percent && cfg.format === "number"))) {
          out.push({
            rule: "R12", target: b.id, detail: `"${label || b.id}" is the brief's KPI "${ask.name}" (target ${ask.target}) but the KPI has no plan`,
            fix: { kind: "plan", blockId: b.id, plan: t.percent ? t.value / 100 : t.value, lowerIsBetter: t.lowerIsBetter },
          });
        }
      }

      // R13 — a value field a person cannot read (it shows in the popover and the export).
      const vf = typeof cfg.valueField === "string" ? cfg.valueField : "";
      if (/^\d/.test(vf)) {
        // A name from what the column is (sum_expected_expiry_baht), unique in its query even across the KPIs that share it.
        const item = itemFor(sql, vf);
        const agg = item ? aggregateOf(item) : null;
        const col = item ? [...item.replace(/\bCASE\s+WHEN[\s\S]*?\bTHEN\b/i, "").matchAll(/"([^"]+)"/g)].map((m) => m[1]!).find((c) => c !== vf && !/^\d/.test(c)) : undefined;
        const stem = (col ? `${(agg ?? "value").toLowerCase()}_${col}` : "kpi_value").replace(/[^\p{L}\p{N}_]/gu, "_").slice(0, 48);
        const taken = named.get(qid) ?? named.set(qid, new Set()).get(qid)!;
        let to = stem;
        for (let i = 2; sql.includes(`"${to}"`) || taken.has(to); i++) to = `${stem}_${i}`;
        taken.add(to);
        // The alias is this KPI's own when no other block of the report reads the field.
        const shared = blocks.some((o) => o.id !== b.id && queryOf(o) === qid && JSON.stringify((o as any).config).includes(`"${vf}"`));
        out.push({
          rule: "R13", target: b.id, detail: `"${label || b.id}" reads its number from a field called ${vf}`,
          ...(!shared && sql.includes(`"${vf}"`) ? { fix: { kind: "rename-field" as const, queryId: qid, blockId: b.id, from: vf, to } } : {}),
        });
      }

      // R16 — a share above 100% or below 0.
      const first = num(rows[0]?.[vf]);
      if (cfg.format === "percent" && first !== null && rows.length === 1 && SHARE_LABEL.test(label) && !CHANGE_LABEL.test(label) && (first > 1.05 || first < -0.001) && Math.abs(first) <= 10) {
        out.push({ rule: "R16", target: b.id, detail: `"${label}" shows ${(first * 100).toFixed(1)}%, a share outside 0-100%` });
      }

      // R19 — an amount read as a percent, or a calculation left in the words.
      const shown = computeKpiValue({ valueField: vf, aggregate: cfg.aggregate }, rows);
      if (cfg.format === "percent" && Number.isFinite(shown) && Math.abs(shown) > 10) {
        // A share-labelled card whose value reads 11-100 is percent points (the query multiplied by 100), not an amount: shown as is, with a % sign.
        const points = SHARE_LABEL.test(label) && !CHANGE_LABEL.test(label) && Math.abs(shown) <= 100 && rows.length === 1;
        out.push({
          rule: "R19", target: b.id, detail: `"${label}" shows ${fmtPercent(shown)}: a raw amount (${Number(shown.toPrecision(6))}) printed as a percent`,
          ...(points ? { fix: { kind: "percent-points" as const, blockId: b.id } } : {}),
        });
      }
      const leaked = LEAKED_CALC.exec(label);
      if (leaked) out.push({ rule: "R19", target: b.id, detail: `"${label}" has a calculation in its words ("${leaked[0]}")` });

      // R27 — a card that shows "–": the query ran and returned rows, and the value field is empty in them.
      // (No rows at all is R5's: the block has no data.)
      if (rows.length > 0 && !Number.isFinite(shown)) {
        const swap = yearLiteralSwap(label, vf, sql) ?? yearFallbackSwap(label, vf, sql);
        out.push({
          rule: "R27", target: b.id, detail: `"${label || b.id}" has no value: ${vf || "its value field"} is empty in what its query returns`,
          ...(swap ? { fix: { kind: "year-literal" as const, blockId: b.id, queryId: qid, valueField: vf, ...swap } } : {}),
        });
      }

      kpiExpressions(b, label, vf, cfg, sql, kpis);
      out.push(...unitViolations(b, label, vf, cfg, sql));
      out.push(...avgRateViolations(b, label, vf, cfg, sql, qid, opts));
      out.push(...rateLabelViolations(b, label, cfg, sql, shown));
      out.push(...percentCardViolations(b, label, cfg, shown));

      // R20 — a ratio over the scope its label names (a percent KPI, with or without a division in its query).
      if (cfg.format === "percent") {
        const word = SCOPE_WORDS.find((w) => w.label.test(label) && !w.sql.test(sql));
        if (word) out.push({ rule: "R20", target: b.id, detail: `"${label}" is a ratio labelled ${word.name}, but neither its numerator nor its denominator is limited to ${word.name}` });
      }
    }

    // R19 — a gauge or a percent-formatted chart whose value is no share; a calculation left in the title.
    if (b.type === "chart") {
      const y0: string | undefined = Array.isArray(cfg.yFields) ? cfg.yFields[0] : undefined;
      const v = y0 ? num(rows[0]?.[y0]) : null;
      const gauge = cfg.chartType === "gauge" || cfg.chartType === "bullet";
      const asPercent = cfg.valueFormat === "percent" || (gauge && typeof cfg.gaugeMax === "number" && cfg.gaugeMax <= 1);
      if (gauge && v !== null && rows.length === 1 && ((asPercent && Math.abs(v) > 10) || (typeof cfg.gaugeMax === "number" && cfg.gaugeMax > 0 && Math.abs(v) > 100 * cfg.gaugeMax))) {
        out.push({ rule: "R19", target: b.id, detail: `"${titleOf(b)}" reads ${asPercent ? fmtPercent(v) : Number(v.toPrecision(6))} on a gauge that ends at ${cfg.gaugeMax ?? 1}: an amount, not a share` });
      }
      // A bar, line or combo chart whose axis prints percent while its values are amounts (or percent points): "200000.0%" on the axis.
      if (!gauge && cfg.valueFormat === "percent" && ["bar", "line", "area", "combo"].includes(cfg.chartType) && rows.length > 0) {
        const ys: string[] = (Array.isArray(cfg.yFields) ? cfg.yFields : []).filter((y: unknown): y is string => typeof y === "string");
        const peak = Math.max(0, ...ys.flatMap((y) => rows.map((r) => Math.abs(num(r[y]) ?? 0))));
        if (peak > 10) out.push({ rule: "R19", target: b.id, detail: `"${titleOf(b)}" prints its values as percent, but they reach ${Number(peak.toPrecision(6)).toLocaleString("en-US")} (${fmtPercent(peak)}): an amount or percent points on a percent axis` });
      }
      const leakedTitle = LEAKED_CALC.exec(String(cfg.title ?? ""));
      if (leakedTitle) out.push({ rule: "R19", target: b.id, detail: `"${titleOf(b)}" has a calculation in its words ("${leakedTitle[0]}")` });
    }

    // R14 — a time axis runs forward; a cumulative line never falls.
    if (b.type === "chart" && ["line", "area", "combo"].includes(cfg.chartType) && typeof cfg.xField === "string") {
      const ys: string[] = (Array.isArray(cfg.yFields) ? cfg.yFields : []).filter((y: unknown): y is string => typeof y === "string");
      const x: string = cfg.xField;
      const clauses = topLevelClauses(sql);
      const key = firstOrderKeyColumns(sql, clauses);
      const timeAxis = TIME_NAME.test(x) || ORDINAL_NAME.test(x);
      const byMeasure = clauses.orderAt !== null && key.length > 0 && key.every((k) => ys.includes(k) && k !== x);
      const cumulative = ys.filter((y) => CUMULATIVE.test(y) || CUMULATIVE.test(String(cfg.seriesLabels?.[y] ?? "")));
      const falling = cumulative.find((y) => {
        const v = rows.map((r) => num(r[y])).filter((n): n is number => n !== null);
        if (v.length < 3) return false;
        const down = v.slice(1).filter((n, i) => n < v[i]! - 1e-9).length;
        return down / (v.length - 1) >= 0.6 && v[0]! > v[v.length - 1]!;
      });
      const xs = rows.map((r) => num(r[x])).filter((n): n is number => n !== null);
      const xBackwards = timeAxis && xs.length >= 3 && xs.length === rows.length && xs.slice(1).filter((n, i) => n < xs[i]!).length / (xs.length - 1) >= 0.8;
      if ((timeAxis && byMeasure) || falling || xBackwards) {
        const keyed = timeOrderKey(sql, x, opts.tableColumns, rows, clauses.hasGroupBy);
        const why = falling ? `"${falling}" is a cumulative series that falls from ${num(rows[0]?.[falling])} to ${num(rows[rows.length - 1]?.[falling])}` : xBackwards ? `its ${x} axis runs backwards` : `its query orders the ${x} axis by ${key.join(", ")}, not by time`;
        const alreadyKeyed = keyed !== null && sql === withOrder(sql, keyed);
        out.push({
          rule: "R14", target: b.id, detail: `"${titleOf(b)}": ${why}`,
          ...(keyed && usersOf.get(qid) === 1 && !alreadyKeyed ? { fix: { kind: "order" as const, queryId: qid, sql: withOrder(sql, keyed) } } : {}),
        });
      }
    }

    // R35 — a time axis with one point per date. A line, area or bar chart draws one value per x; rows that
    // repeat a date (one per branch) make it jump between them instead of showing the date's total
    // ("Daily sales in July", Make a report, 2026-11-01). Several series go in yFields, never as repeated rows.
    if (b.type === "chart" && ["line", "area", "bar"].includes(cfg.chartType) && typeof cfg.xField === "string" && !cfg.colorField && TIME_NAME.test(cfg.xField) && rows.length >= 4) {
      const seen = new Map<string, number>();
      for (const r of rows) { const k = String(r[cfg.xField] ?? ""); seen.set(k, (seen.get(k) ?? 0) + 1); }
      const repeated = [...seen.values()].filter((n) => n > 1).length;
      if (repeated >= 2) {
        out.push({ rule: "R35", target: b.id, detail: `"${titleOf(b)}" plots ${rows.length} rows over ${seen.size} values of ${cfg.xField}: several rows share a ${cfg.xField}, so the chart jumps between them instead of showing one figure each` });
      }
    }

    // R15 — a year in the words the query never filters to.
    if (b.type === "kpi" || b.type === "chart" || b.type === "table") {
      const words = String(b.type === "kpi" ? cfg.label ?? "" : cfg.title ?? "");
      const year = STATED_YEAR.exec(words)?.[1];
      if (year && !MULTI_YEAR_WORDS.test(words) && !YEAR_RANGE.test(words)) {
        const y = Number(year);
        // The year as a value or in a column name (installment_2571) — not in the table's name (carryover_fy2568_2569 holds both years).
        const withoutTables = sql
          .replace(/\b(from|join)\s+(?:"[^"]*"|\w+)(?:\s*\.\s*(?:"[^"]*"|\w+))?/gi, "$1 t")
          .replace(/\bwith\s+(?:"[^"]*"|\w+)\s+as\b/gi, "with t as");
        const literal = new RegExp(`(?<!\\d)(?:${y}|${y - 543}|${y + 543})(?!\\d)`).test(withoutTables);
        const bound = [...sql.matchAll(/:(\w+)/g)].some((m) => /year|fy|ปี/i.test(m[1]!) && paramNames.has(m[1]!));
        const yearCols = tablesRead(sql).flatMap((t) => opts.tableColumns?.[t] ?? []).filter((c) => YEAR_COLUMN.test(c));
        const resultYear = rows.length > 0 ? Object.keys(rows[0]!).find((k) => YEAR_COLUMN.test(k)) : undefined;
        const distinct = resultYear ? new Set(rows.map((r) => String(r[resultYear]))).size : 0;
        const grouped = resultYear && new RegExp(`group\\s+by[^;]*"?${resultYear}"?`, "i").test(sql);
        if (!literal && !bound && !grouped && (distinct > 1 || (!resultYear && yearCols.length > 0))) {
          out.push({
            rule: "R15", target: b.id,
            detail: `"${words}" names ${year}, but its query has no filter on ${resultYear ?? yearCols[0] ?? "a year column"}${distinct > 1 ? ` and its result spans ${distinct} years` : ""}`,
          });
        }
      }
    }

    // R17 — a column of numbers printed with every decimal.
    if (b.type === "table" && rows.length > 0) {
      const configured: any[] = Array.isArray(cfg.columns) ? cfg.columns : [];
      const keys = configured.length ? configured.map((c) => c.key) : Object.keys(rows[0]!);
      const fixes: Array<{ key: string; type: "number" | "percent"; format?: string }> = [];
      for (const key of keys) {
        const col = configured.find((c) => c.key === key);
        const type = col?.type ?? "string";
        if (type !== "string" && type !== "number") continue;
        if (type === "number" && /^\d+$/.test(col?.format ?? "")) continue;
        const vals = rows.map((r) => r[key]).filter((v) => v != null && v !== "");
        if (vals.length === 0 || !vals.every((v) => typeof v === "number" && Number.isFinite(v))) continue;
        const long = (vals as number[]).some((v) => Math.abs(v * 100 - Math.round(v * 100)) > 1e-6 * Math.max(1, Math.abs(v)));
        if (!long) continue;
        const max = Math.max(...(vals as number[]).map(Math.abs));
        const fraction = /pct|percent|ratio|share|rate|สัดส่วน|ร้อยละ|%/i.test(key) && max <= 1.0001;
        fixes.push(fraction ? { key, type: "percent" } : { key, type: "number", format: max >= 10000 ? "0" : max >= 100 ? "1" : "2" });
      }
      if (fixes.length) {
        out.push({ rule: "R17", target: b.id, detail: `"${titleOf(b)}" prints ${fixes.map((f) => f.key).slice(0, 3).join(", ")} with every decimal`, fix: { kind: "column-format", blockId: b.id, columns: fixes } });
      }
    }

    // R18 — a KPI opens the rows behind it: the report's own detail table when one lists them, else the rows its own query counts.
    if (b.type === "kpi" && !cfg.drilldown) {
      const vf = typeof cfg.valueField === "string" ? cfg.valueField : "";
      const table = detailTableFor(sql, vf, blocks, qid, sqlById, paramNames);
      if (table) {
        out.push({ rule: "R18", target: b.id, detail: `"${cfg.label ?? b.id}" has no drill-down although the report lists the rows behind it`, fix: { kind: "drill", blockId: b.id, queryId: table } });
      } else {
        const own = report.dataSources.find((d) => d.id === qid);
        const derived = own?.sql && vf ? deriveDetailSql(own.sql, vf, { tableColumns: opts.tableColumns }) : null;
        if (derived && own) {
          out.push({
            rule: "R18", target: b.id, detail: `"${cfg.label ?? b.id}" has no drill-down; the rows behind it come from its own query`,
            fix: { kind: "drill-new", blockId: b.id, queryId: `q_drill_${b.id.replace(/[^\w]/g, "")}`, dataSourceId: own.dataSourceId, name: `Rows behind ${String(cfg.label ?? b.id).slice(0, 50)}`, sql: derived.sql },
          });
        }
      }
    }
  }

  out.push(...gapConsistency(blocks, sqlById, dataset), ...blankAndOutliers(blocks, dataset));
  out.push(...duplicateKpis(report, kpis, opts.kpiAsks));
  return out;
}

// ── R18: which of the report's tables holds the rows behind a KPI ───────

/** The base tables a query reads: every FROM/JOIN name that is not a CTE of its own making (a guard CTE shadowing its table counts as the table). */
export function baseTables(sql: string): Set<string> {
  const ctes = splitWith(sql)?.ctes ?? [];
  return new Set(tablesRead(sql).filter((n) => {
    const cte = ctes.find((c) => c.name === n);
    return !cte || new RegExp(`(?:from|join)\\s+(?:"?\\w+"?\\.)?"?${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?(?![\\w"])`, "i").test(cte.body);
  }));
}

const normCond = (c: string): string => c.toLowerCase().replace(/cast\s*\(\s*("?\w+"?)\s+as\s+\w+\s*\)/g, "$1").replace(/["\s]/g, "").replace(/^\(+|\)+$/g, "");

/** The conditions a query keeps rows by: every WHERE (CTEs included), without the report-parameter guards and IS NOT NULL, plus the CASE WHEN conditions of the value. */
function keptBy(sql: string, valueField?: string): string[] {
  const w = splitWith(sql);
  const parts = [...(w?.ctes.map((c) => c.body) ?? []), w?.main ?? sql];
  const conds: string[] = [];
  for (const part of parts) {
    const m = /\bwhere\b([\s\S]*?)(?:\bgroup\s+by\b|\border\s+by\b|\blimit\b|;|$)/i.exec(part);
    if (m) conds.push(...m[1]!.replace(/\(\s*:\w+\s*=\s*''\s*OR[^)]*\)/gi, " ").split(/\band\b/i));
  }
  if (valueField) { const item = itemFor(w?.main ?? sql, valueField); if (item) conds.push(...caseConditions(item)); }
  return conds.map(normCond).filter((c) => c && !/isnotnull$/.test(c));
}

/**
 * The report's own table that lists the rows behind a KPI: it reads the same
 * base tables, keeps rows by at least the KPI's conditions (so every row it
 * lists is one the KPI counted), is not grouped or aggregated, is not a short
 * top-N list, and binds only the report's parameters. The one with no LIMIT
 * wins, then the first.
 */
function detailTableFor(sql: string, valueField: string, blocks: Block[], ownQuery: string, sqlById: Map<string, string>, paramNames: Set<string>): string | null {
  const mine = baseTables(sql);
  if (mine.size === 0) return null;
  const want = keptBy(sql, valueField);
  const found: Array<{ q: string; unlimited: boolean }> = [];
  for (const t of blocks) {
    if (t.type !== "table") continue;
    const tq = queryOf(t);
    const tsql = tq ? sqlById.get(tq) ?? "" : "";
    if (!tq || tq === ownQuery || !tsql || found.some((f) => f.q === tq)) continue;
    const main = splitWith(tsql)?.main ?? tsql;
    if (findTop(main, /^group\s+by\b/i) >= 0 || /\b(?:sum|avg|count|min|max)\s*\(/i.test(main)) continue;
    const lim = /\blimit\s+(\d+)\s*;?\s*$/i.exec(tsql);
    if (lim && Number(lim[1]) < 100) continue;
    if ([...tsql.matchAll(/(?<![:\w]):(\w+)/g)].some((m) => !paramNames.has(m[1]!))) continue;
    const theirs = baseTables(tsql);
    if (theirs.size !== mine.size || ![...theirs].every((n) => mine.has(n))) continue;
    const have = keptBy(tsql).join("&");
    if (!want.every((c) => have.includes(c))) continue;
    found.push({ q: tq, unlimited: !lim });
  }
  return (found.find((f) => f.unlimited) ?? found[0])?.q ?? null;
}

// ── R21: a gap agrees with the actual and the target next to it ────────

const GAP_LABEL = /\bgap\b|variance|shortfall|difference|vs\.? target|against target|ส่วนต่าง|ช่องว่าง|เทียบเป้า|ต่างจากเป้า|差距|缺口|差额/i;

/** A gap to something: only one measured against a target, a plan or a goal is "actual minus target" (the gap between the best and the worst is not). */
const AGAINST_TARGET = /target|plan|goal|budget|เป้า|แผน|งบ|目标|计划|预算/i;

function gapConsistency(blocks: Block[], sqlById: Map<string, string>, dataset: Dataset): NumberViolation[] {
  const out: NumberViolation[] = [];
  const kpis = blocks.filter((b) => b.type === "kpi").map((b) => {
    const cfg: any = (b as any).config;
    const rows = dataset[cfg.queryId] ?? [];
    return { b, cfg, rows, label: String(cfg.label ?? ""), value: computeKpiValue({ valueField: cfg.valueField, aggregate: cfg.aggregate }, rows) };
  }).filter((k) => Number.isFinite(k.value));
  for (const gap of kpis) {
    // A label that states its own number ("vs target 100%") is the actual measured against it, not a gap.
    if (!GAP_LABEL.test(gap.label) || !AGAINST_TARGET.test(gap.label) || targetFromLabel(gap.label) || gap.cfg.format === "currency") continue;
    // The actual: the one other KPI of the same unit read from the same query that is not itself a gap (two candidates: no telling which).
    const actuals = kpis.filter((k) => k !== gap && !GAP_LABEL.test(k.label) && k.cfg.format === gap.cfg.format && k.cfg.queryId === gap.cfg.queryId && k.value > -10 && k.value < 10);
    if (actuals.length !== 1) continue;
    const actual = actuals[0]!;
    // The target: a plan on either KPI, a target the labels state, or the constant the gap's own query subtracts.
    const scale = gap.cfg.format === "percent" ? 100 : 1;
    const planOf = (k: typeof gap): number | null => {
      if (typeof k.cfg.plan === "number") return k.cfg.plan;
      return k.cfg.planField ? num(k.rows[0]?.[k.cfg.planField]) : null;
    };
    const stated = [gap, actual].map((k) => targetFromLabel(k.label)).find((t) => t);
    const sql = sqlById.get(gap.cfg.queryId) ?? "";
    const constant = /-\s*(\d+(?:\.\d+)?)\s+(?:ELSE|END)\b/i.exec(sql)?.[1];
    const target = planOf(actual) ?? planOf(gap) ?? (stated ? (stated.percent && scale === 100 ? stated.value / 100 : stated.value) : constant != null ? Number(constant) / scale : null);
    if (target === null || !Number.isFinite(target)) continue;
    const expected = actual.value - target;
    // "Gap to a ceiling" counts the other way (ceiling minus actual): the size is what must agree.
    if (Math.abs(Math.abs(gap.value) - Math.abs(expected)) <= Math.max(0.01 * (scale === 100 ? 1 : scale), 0.15 * Math.abs(expected))) continue;
    const f = (v: number) => (scale === 100 ? `${Number((v * 100).toFixed(1))}%` : String(Number(v.toPrecision(4))));
    out.push({
      rule: "R21", target: gap.b.id,
      detail: `"${gap.label.slice(0, 60)}" shows ${f(gap.value)}, but "${actual.label.slice(0, 50)}" (${f(actual.value)}) minus the target (${f(target)}) is ${f(expected)}`,
    });
  }
  return out;
}

// ── R22: blanks and outliers in what a series shows ─────────────────────

const median = (v: number[]): number => { const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const isBlank = (v: unknown) => v == null || v === "" || (typeof v === "number" && Number.isNaN(v));

function blankAndOutliers(blocks: Block[], dataset: Dataset): NumberViolation[] {
  const out: NumberViolation[] = [];
  for (const b of blocks) {
    const cfg: any = (b as any).config ?? {};
    const rows = dataset[cfg.queryId] ?? [];
    const chart = b.type === "chart" && ["bar", "line", "area", "combo"].includes(cfg.chartType);
    if (!(chart || b.type === "table") || rows.length < 4) continue;
    const fields: string[] = chart
      ? (Array.isArray(cfg.yFields) ? cfg.yFields : []).filter((y: unknown): y is string => typeof y === "string")
      : (Array.isArray(cfg.columns) ? cfg.columns : []).filter((c: any) => c?.type === "number" || c?.type === "currency" || c?.type === "percent").map((c: any) => c.key as string);
    for (const y of fields.slice(0, 6)) {
      const raw = rows.map((r) => r[y]);
      const nums = raw.filter((v) => !isBlank(v)).map(Number).filter((n) => Number.isFinite(n));
      const blanks = raw.length - raw.filter((v) => !isBlank(v)).length;
      const name = String(cfg.seriesLabels?.[y] ?? y);
      // A bar or a point that is missing among the others: the reader sees a gap and cannot tell "none" from "not loaded".
      if (blanks >= 1 && nums.length >= 2 && blanks <= raw.length * 0.5) {
        out.push({ rule: "R22", target: b.id, info: !chart, detail: `"${titleOf(b)}": ${blanks} of ${raw.length} rows have no value for ${name}, while the others do` });
      }
      if (chart && nums.length >= 5) {
        const sorted = [...nums].sort((a, c) => c - a);
        const med = median(nums.map(Math.abs));
        if (med > 0 && Math.abs(sorted[0]!) > 10 * med && Math.abs(sorted[0]!) > 3 * Math.abs(sorted[1]!)) {
          out.push({ rule: "R22", target: b.id, info: true, detail: `"${titleOf(b)}": ${name} has a value (${Number(sorted[0]!.toPrecision(4))}) more than 10 times the median (${Number(med.toPrecision(3))}) and 3 times the next one` });
        }
      }
    }
  }
  return out;
}

// ── The repairs ─────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Carry out a violation's mechanical repair on `report` (mutating it, as the
 * gate and the repair loop both work on a copy) and, for a renamed field, on
 * `dataset`'s rows. Returns what was done (the block's title) or null when
 * there was nothing to change.
 */
export function applyRuleFix(report: Report, fix: NumberRuleFix, dataset: Dataset): { title: string } | null {
  const blocks = report.pages.flatMap((p) => p.blocks);
  const block = "blockId" in fix ? blocks.find((b) => b.id === fix.blockId) : undefined;
  const cfg: any = (block as any)?.config;
  switch (fix.kind) {
    case "plan": {
      if (!block || cfg.plan != null || cfg.planField) return null;
      cfg.plan = fix.plan;
      if (fix.lowerIsBetter && !cfg.sparkPositive) cfg.sparkPositive = "down";
      return { title: titleOf(block) };
    }
    case "column-format": {
      if (!block || block.type !== "table") return null;
      const rows = dataset[queryOf(block) ?? ""] ?? [];
      if (!Array.isArray(cfg.columns) || cfg.columns.length === 0) {
        if (!rows.length) return null;
        cfg.columns = Object.keys(rows[0]!).map((key) => ({ key, label: key, type: "string", total: "none" }));
      }
      let changed = false;
      for (const f of fix.columns) {
        const col = cfg.columns.find((c: any) => c.key === f.key);
        if (!col) continue;
        col.type = f.type;
        if (f.format !== undefined) col.format = f.format; else delete col.format;
        changed = true;
      }
      return changed ? { title: titleOf(block) } : null;
    }
    case "order": {
      const ds = report.dataSources.find((d) => d.id === fix.queryId);
      if (!ds || ds.sql === fix.sql) return null;
      ds.sql = fix.sql;
      const user = blocks.find((b) => queryOf(b) === fix.queryId);
      return { title: user ? titleOf(user) : fix.queryId };
    }
    case "rename-field": {
      const ds = report.dataSources.find((d) => d.id === fix.queryId);
      if (!ds?.sql || !block || fix.to === fix.from) return null;
      const next = ds.sql.replace(new RegExp(`"${esc(fix.from)}"`, "g"), `"${fix.to}"`);
      if (next === ds.sql) return null;
      ds.sql = next;
      for (const k of ["valueField", "compareField", "planField", "shareOfField", "sparkValueField"]) if (cfg[k] === fix.from) cfg[k] = fix.to;
      for (const r of dataset[fix.queryId] ?? []) if (fix.from in r) { r[fix.to] = r[fix.from]; delete r[fix.from]; }
      return { title: titleOf(block) };
    }
    case "drill": {
      if (!block || cfg.drilldown) return null;
      if (!report.dataSources.some((d) => d.id === fix.queryId)) return null;
      cfg.drilldown = { queryId: fix.queryId, ...(typeof cfg.label === "string" ? { title: cfg.label } : {}) };
      return { title: titleOf(block) };
    }
    case "drill-new": {
      if (!block || cfg.drilldown) return null;
      // Two KPIs reading the same rows share one drill query.
      const same = report.dataSources.find((d) => d.sql === fix.sql);
      const id = same?.id ?? fix.queryId;
      if (!same) report.dataSources.push({ id, name: fix.name, dataSourceId: fix.dataSourceId, sql: fix.sql } as Report["dataSources"][number]);
      cfg.drilldown = { queryId: id, ...(typeof cfg.label === "string" ? { title: cfg.label } : {}) };
      return { title: titleOf(block) };
    }
    case "drop-duplicate": {
      const keep = blocks.find((b) => b.id === fix.keepId);
      if (!block || !keep || block.id === keep.id) return null;
      const kept: any = (keep as any).config;
      // What the dropped card had and the kept one lacks (a plan, a drill-down, a sparkline) is not lost with it.
      for (const k of ["plan", "planField", "drilldown", "sparkQueryId", "sparkValueField", "sparkLabelField", "compareField"]) {
        if (kept[k] == null && cfg[k] != null) kept[k] = cfg[k];
      }
      const title = titleOf(block);
      dropBlock(report, block.id);
      return { title };
    }
    case "weighted-ratio": {
      const ds = report.dataSources.find((d) => d.id === fix.queryId);
      if (!ds?.sql || !block || ds.sql === fix.sql) return null;
      ds.sql = fix.sql;
      return { title: titleOf(block) };
    }
    case "percent-points": {
      if (!block || cfg.format !== "percent") return null;
      cfg.format = "number";
      cfg.suffix = "%";
      return { title: titleOf(block) };
    }
    case "year-literal": {
      const ds = report.dataSources.find((d) => d.id === fix.queryId);
      const item = ds?.sql ? itemFor(ds.sql, fix.valueField) : null;
      if (!ds?.sql || !item || !block) return null;
      const next = item.replace(new RegExp(`=\\s*${fix.from}(?!\\d)`, "g"), `= ${fix.to}`);
      // The column is named for the year it reads (fy2570): it takes the new year's name, once, in its own query.
      let alias = fix.valueField.includes(String(fix.from)) ? fix.valueField.replace(String(fix.from), String(fix.to)) : fix.valueField;
      for (let i = 2; alias !== fix.valueField && ds.sql.includes(`"${alias}"`); i++) alias = `${fix.valueField.replace(String(fix.from), String(fix.to))}_${i}`;
      const renamed = next.replace(new RegExp(`(\\bas\\s+)"?${esc(fix.valueField)}"?(\\s*)$`, "i"), `$1"${alias}"$2`);
      if (renamed === item) return null;
      ds.sql = ds.sql.replace(item, renamed);
      cfg.valueField = alias;
      // Its own drill-down opens the rows of the year the card now shows.
      const dq = report.dataSources.find((d) => d.id === cfg.drilldown?.queryId && d.id.startsWith("q_drill_"));
      if (dq?.sql && !blocks.some((o) => o.id !== block.id && (o as any).config?.drilldown?.queryId === dq.id)) {
        dq.sql = dq.sql.replace(new RegExp(`=\\s*${fix.from}(?!\\d)`, "g"), `= ${fix.to}`);
        if (typeof cfg.drilldown.title === "string") cfg.drilldown.title = cfg.drilldown.title.replace(String(fix.from), String(fix.to));
      }
      for (const words of Object.values((block as any).i18n ?? {}) as Array<Record<string, string>>) {
        if (typeof words["drilldown.title"] === "string") words["drilldown.title"] = words["drilldown.title"].replace(String(fix.from), String(fix.to));
      }
      // The year had no data: the card's words say the year it now shows, in every language it has words in.
      if (fix.relabel) {
        const move = (s: string) => s.split(fix.relabel!.from).join(fix.relabel!.to);
        if (typeof cfg.label === "string") cfg.label = move(cfg.label);
        for (const words of Object.values((block as any).i18n ?? {}) as Array<Record<string, string>>) {
          if (typeof words.label === "string") words.label = move(words.label);
          if (typeof words.title === "string") words.title = move(words.title);
        }
      }
      for (const r of dataset[fix.queryId] ?? []) if (fix.valueField in r) { r[alias] = r[fix.valueField]; delete r[fix.valueField]; }
      return { title: titleOf(block) };
    }
    case "strip-unit": {
      if (!block || typeof cfg.label !== "string") return null;
      const strip = (s: string) => s.replace(unitOfLabel(s)?.phrase ?? "\u0000", "").replace(/\s{2,}/g, " ").trim();
      const next = strip(cfg.label);
      if (!next || next === cfg.label) return null;
      cfg.label = next;
      // Each language's own label carries the phrase in its own words.
      for (const words of Object.values((block as any).i18n ?? {}) as Array<Record<string, string>>) {
        if (typeof words.label === "string") words.label = strip(words.label) || words.label;
      }
      return { title: next };
    }
  }
}

/** Close any grid row no block covers any more. */
export function compactRows<T extends { y: number; h: number }>(blocks: T[]): T[] {
  let out = blocks.map((b) => ({ ...b }));
  const bottom = out.reduce((m, b) => Math.max(m, b.y + b.h), 0);
  for (let row = bottom - 1; row >= 0; row--) {
    if (out.some((b) => b.y <= row && row < b.y + b.h)) continue;
    out = out.map((b) => (b.y > row ? { ...b, y: b.y - 1 } : b));
  }
  return out;
}

/** Take a block off a report (mutating it), with the queries only it read and the rows it leaves empty. */
function dropBlock(report: Report, id: string): void {
  report.pages = report.pages.map((p) => ({ ...p, blocks: compactRows(p.blocks.filter((b) => b.id !== id)) }));
  const used = neededQueries(report.dataSources, report.pages);
  report.dataSources = report.dataSources.filter((d) => used.has(d.id));
}
