/**
 * The rows behind a KPI, written from the KPI's own query.
 *
 * A KPI's SQL is an aggregate over a table (often through a guard CTE that
 * applies the report's filters, or a CTE that groups). The rows behind its
 * number are the same source with the same conditions and without the
 * aggregate: the guard CTEs stay (so a filter the reader set still applies),
 * an aggregating CTE is replaced by its own FROM ... WHERE, and the
 * conditions inside the value's CASE WHEN (`SUM(CASE WHEN fiscal_year = 2569
 * THEN x END)`) become the WHERE. Nothing is invented: every table, column and
 * condition comes from the KPI's query, and the result must pass the same
 * SELECT-only guard every query does (sqlGuard.ts).
 *
 * Pure: no server imports.
 */
import { assertSelectOnly } from "@/lib/reporting/sqlGuard";
import { itemFor } from "./reportRules";

type Cte = { name: string; body: string };

const unquote = (s: string) => s.replace(/^"|"$/g, "");

/** Index of the matching `)` for the `(` at `open`, outside quotes; -1 when unbalanced. */
function matchParen(sql: string, open: number): number {
  let depth = 0, quote: string | null = null;
  for (let i = open; i < sql.length; i++) {
    const ch = sql[i]!;
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** `WITH a AS (...), b AS (...) <main>`: the CTEs and the main select. Null when there is no WITH or it does not parse. */
export function splitWith(sql: string): { ctes: Cte[]; main: string } | null {
  const head = /^\s*with\s+(?:recursive\s+)?/i.exec(sql);
  if (!head) return null;
  let i = head[0].length;
  const ctes: Cte[] = [];
  for (;;) {
    const m = /^\s*("[^"]+"|[\p{L}\w]+)\s*(?:\([^)]*\)\s*)?as\s*(?:not\s+materialized\s*|materialized\s*)?\(/iu.exec(sql.slice(i));
    if (!m) return null;
    const open = i + m[0].length - 1;
    const close = matchParen(sql, open);
    if (close < 0) return null;
    ctes.push({ name: unquote(m[1]!), body: sql.slice(open + 1, close).trim() });
    i = close + 1;
    const comma = /^\s*,/.exec(sql.slice(i));
    if (comma) { i += comma[0].length; continue; }
    return { ctes, main: sql.slice(i).trim() };
  }
}

/** Index of the first `word` (a keyword) at depth 0 outside quotes, or -1. */
export function findTop(sql: string, word: RegExp, from = 0): number {
  let depth = 0, quote: string | null = null;
  for (let i = from; i < sql.length; i++) {
    const ch = sql[i]!;
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "(") { depth++; continue; }
    if (ch === ")") { depth--; continue; }
    if (depth === 0 && /[A-Za-z]/.test(ch) && (i === 0 || !/[\w"]/.test(sql[i - 1]!))) {
      const m = word.exec(sql.slice(i));
      if (m && m.index === 0) return i;
    }
  }
  return -1;
}

const AGG = /\b(?:sum|avg|count|min|max|stddev|median|percentile_cont)\s*\(/i;

/** Whether a SELECT groups or aggregates at its top level (its select list or a GROUP BY). */
function aggregates(select: string): boolean {
  if (findTop(select, /^group\s+by\b/i) >= 0) return true;
  const from = findTop(select, /^from\b/i);
  return AGG.test(from >= 0 ? select.slice(0, from) : select);
}

/** The top-level `FROM ...` of a select, cut before GROUP BY / HAVING / ORDER BY / LIMIT. */
function fromClause(select: string): string | null {
  const from = findTop(select, /^from\b/i);
  if (from < 0) return null;
  const rest = select.slice(from);
  let end = rest.length;
  for (const stop of [/^group\s+by\b/i, /^having\b/i, /^order\s+by\b/i, /^limit\b/i, /^union\b/i]) {
    const at = findTop(rest, stop);
    if (at >= 0) end = Math.min(end, at);
  }
  return rest.slice(0, end).trim().replace(/;\s*$/, "");
}

/** The conditions of the `CASE WHEN <cond> THEN` a select item aggregates (`NOT (x IS NULL)`, `year = 2569`). */
export function caseConditions(item: string): string[] {
  const out: string[] = [];
  for (const m of item.matchAll(/\bCASE\s+WHEN\b/gi)) {
    const start = m.index! + m[0].length;
    // The THEN that closes this WHEN at the same depth.
    const then = findTop(item, /^then\b/i, start);
    if (then > start) out.push(item.slice(start, then).trim());
  }
  return out;
}

const hasWhere = (clause: string) => findTop(clause, /^where\b/i) >= 0;

const ID_COLUMN = /(^|_)(id|code|name|no|number)$|^(project|office|province|region|stage|method|status|vendor|supplier|agency|department)(_|$)/i;
const YEAR_COL = /^(?:fiscal_year|fy|year|reserve_fy|budget_year)$/i;
const MAX_COLUMNS = 8;

/** Up to eight columns that tell a reader which rows these are and what they hold: identifiers, the period, the measure. */
export function pickColumns(columns: string[], measures: string[]): string[] {
  const picked: string[] = [];
  const add = (c: string | undefined, cap = MAX_COLUMNS) => { if (c && !picked.includes(c) && picked.length < cap) picked.push(c); };
  // Identifiers first but never all the room: the measure the KPI adds up must be on the panel.
  const ids = columns.filter((c) => ID_COLUMN.test(c));
  for (const c of ids.filter((c) => /(name|code|id)$/i.test(c))) add(c, 4);
  for (const c of ids) add(c, 5);
  for (const c of columns) if (YEAR_COL.test(c)) add(c);
  for (const m of measures) if (columns.includes(m)) add(m);
  for (const c of columns) add(c);
  return picked;
}

export type DerivedDrill = { sql: string; /** The measure the rows are ordered by, when one is shown. */ orderedBy?: string };

/**
 * The query that lists the rows behind the KPI's `valueField`, or null when
 * its SQL has no readable source (no FROM, an unbalanced CTE list, a UNION).
 * `tableColumns` (the lake's columns by table) lets the panel show eight
 * useful columns instead of every one; without it the rows come whole.
 */
export function deriveDetailSql(sql: string, valueField: string, opts: { tableColumns?: Record<string, string[]>; /** Rows to list; 0 for all of them (a sum over the rows needs them all). */ limit?: number } = {}): DerivedDrill | null {
  const limit = opts.limit ?? 500;
  const w = splitWith(sql);
  const ctes = w?.ctes ?? [];
  const main = (w?.main ?? sql).trim().replace(/;\s*$/, "");
  if (findTop(main, /^union\b/i) >= 0 || /^\s*\(/.test(main)) return null;
  const mainFrom = fromClause(main);
  if (!mainFrom) return null;
  const src = /^from\s+(?:(?:"[^"]+"|\w+)\s*\.\s*)?("[^"]+"|[\p{L}\w]+)/iu.exec(mainFrom);
  if (!src) return null;
  const srcName = unquote(src[1]!);
  const item = itemFor(main, valueField) ?? "";
  const conds = caseConditions(item);

  let prefix: Cte[];
  let from: string;
  let baseTable: string | null = null;
  const cte = ctes.find((c) => c.name === srcName);
  if (cte && aggregates(cte.body)) {
    // The CTE groups: the rows behind it are what it reads.
    const f = fromClause(cte.body);
    if (!f) return null;
    // Only the CTE's own WHERE; its GROUP BY, HAVING and select list belong to the aggregate.
    prefix = ctes.slice(0, ctes.indexOf(cte));
    from = f;
    const t = /^from\s+(?:(?:"[^"]+"|\w+)\s*\.\s*)?("[^"]+"|[\p{L}\w]+)(?:\s+(?:as\s+)?\w+)?\s*$/iu.exec(f.replace(/\s+where[\s\S]*$/i, ""));
    baseTable = t ? unquote(t[1]!) : null;
  } else if (cte) {
    prefix = ctes;
    from = `FROM "${cte.name}"`;
    if (hasWhere(mainFrom)) from = mainFrom;
  } else {
    prefix = ctes;
    from = mainFrom;
    baseTable = srcName;
  }

  // The value's own conditions narrow the rows exactly as the CASE WHEN narrowed the aggregate.
  const extra = conds.filter((c) => c && !/^\(?\s*:\w+/.test(c));
  let body = from;
  if (extra.length) body += hasWhere(from) ? ` AND (${extra.join(") AND (")})` : ` WHERE ${extra.join(" AND ")}`;

  // Columns: the base table's useful eight when it is one table we know, else all of them.
  const known = baseTable ? opts.tableColumns?.[baseTable] : undefined;
  const measures = [...item.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).filter((c) => c !== valueField);
  const columns = known && known.length > MAX_COLUMNS && !/\bjoin\b/i.test(from) ? pickColumns(known, measures) : null;
  const measure = columns ? measures.find((m) => columns.includes(m) && !YEAR_COL.test(m)) : undefined;
  const select = columns ? columns.map((c) => `"${c}"`).join(", ") : "*";
  const order = measure ? ` ORDER BY CAST("${measure}" AS DOUBLE) DESC NULLS LAST` : "";
  const head = prefix.length ? `WITH ${prefix.map((c) => `"${c.name}" AS (${c.body})`).join(", ")} ` : "";
  const out = `${head}SELECT ${select} ${body}${order}${limit > 0 ? ` LIMIT ${limit}` : ""}`;
  try { assertSelectOnly(out); } catch { return null; }
  return { sql: out, orderedBy: measure };
}
