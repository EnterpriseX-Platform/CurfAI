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

type Row = Record<string, unknown>;
type Block = Report["pages"][number]["blocks"][number];

export type NumberRuleFix =
  | { kind: "plan"; blockId: string; plan: number; lowerIsBetter: boolean }
  | { kind: "column-format"; blockId: string; columns: Array<{ key: string; type: "number" | "percent"; format?: string }> }
  | { kind: "order"; queryId: string; sql: string }
  | { kind: "rename-field"; queryId: string; blockId: string; from: string; to: string }
  | { kind: "drill"; blockId: string; queryId: string }
  /** A drill-down with a query of its own: the KPI's rows, written from the KPI's SQL (drillQuery.ts). */
  | { kind: "drill-new"; blockId: string; queryId: string; dataSourceId: string; name: string; sql: string };

export type NumberViolation = {
  rule: RuleId; target: string; detail: string; fix?: NumberRuleFix;
  /** A note for the verifier and the repair brief, not for the report's reader: the gate does not flag it. */
  info?: boolean;
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

// ── The detection ───────────────────────────────────────────────────────

const SHARE_LABEL = /share|ratio|rate|สัดส่วน|อัตรา|ร้อยละ|เปอร์เซ็นต์|% of|percent of|completion|achievement|progress|ความคืบหน้า|占比|比例|比率|完成率/i;
const CHANGE_LABEL = /growth|change|yoy|mom|increase|decrease|เติบโต|เปลี่ยนแปลง|เพิ่มขึ้น|ลดลง|增长|变化|同比|环比/i;

export function detectNumberRules(
  report: Report, dataset: Dataset, opts: { tableColumns?: Record<string, string[]> } = {},
): NumberViolation[] {
  const out: NumberViolation[] = [];
  const blocks = report.pages.flatMap((p) => p.blocks);
  const sqlById = new Map(report.dataSources.map((d) => [d.id, d.sql ?? ""]));
  const paramNames = new Set((report.parameters ?? []).map((p) => p.name));
  const usersOf = new Map<string, number>();
  for (const b of blocks) { const q = queryOf(b); if (q) usersOf.set(q, (usersOf.get(q) ?? 0) + 1); }
  const named = new Map<string, Set<string>>();

  for (const b of blocks) {
    const cfg = (b as any).config ?? {};
    const qid = queryOf(b);
    if (!qid) continue;
    const sql = sqlById.get(qid) ?? "";
    const rows = dataset[qid] ?? [];

    if (b.type === "kpi") {
      const label = typeof cfg.label === "string" ? cfg.label : "";

      // R12 — a target in the words, no plan on the card.
      if (label && cfg.plan == null && !cfg.planField) {
        const t = targetFromLabel(label);
        if (t) {
          // A rate or a plain number takes the target as it is written; money with a target "of the base" needs a plan column, which code cannot invent.
          const fixable = cfg.format === "percent" || (cfg.format === "number" && !/\s(?:ของ|of)\s/i.test(label.slice(label.search(TARGET_RE))));
          out.push({
            rule: "R12", target: b.id, detail: `"${label}" states a target of ${t.value}${t.percent ? "%" : ""} but the KPI has no plan`,
            ...(fixable ? { fix: { kind: "plan" as const, blockId: b.id, plan: cfg.format === "percent" ? t.value / 100 : t.value, lowerIsBetter: t.lowerIsBetter } } : {}),
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
        out.push({ rule: "R19", target: b.id, detail: `"${label}" shows ${fmtPercent(shown)}: a raw amount (${Number(shown.toPrecision(6))}) printed as a percent` });
      }
      const leaked = LEAKED_CALC.exec(label);
      if (leaked) out.push({ rule: "R19", target: b.id, detail: `"${label}" has a calculation in its words ("${leaked[0]}")` });

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
  }
}
