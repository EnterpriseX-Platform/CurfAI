/**
 * Number columns the SQLite lake keeps as TEXT, and SQL that would misread
 * them.
 *
 * The SQLite engine stores every column as TEXT (tables.ts header; typed
 * storage is E1b, behind CURF_LAKE_TYPED_COLUMNS). The catalog still says
 * "number", so a model writing its own query treats the column as one — and
 * SQLite then compares and sorts it as text: `ORDER BY fiscal_month` gives
 * 1, 10, 11, 12, 2 …; `budget > 500000` is true for "6000"; `MAX(amount)` is
 * "99" over "1000". SUM/AVG are fine (they convert). Nothing errors; the
 * answer is just wrong.
 *
 * A column whose values all have the same number of digits (a year) is left
 * alone: it sorts right either way. Otherwise query_lake checks the SQL
 * before it runs and sends it back, naming the
 * columns and the fix (CAST(col AS DOUBLE)), for the model to write again —
 * a code check, not a prompt line the model may skip. get_lake_table_schema
 * says the same up front. DuckDB-engine tenants and columns stored typed are
 * left alone: their numbers compare as numbers.
 */
import { prisma } from "@/lib/db";
import { ee } from "@/ee";
import { openLake, toSafeTableName } from "./storage";
import { storedColumnTypes } from "./tables";
import { parseSchemaJson } from "./schemaGovernance";
import { referencesTable } from "./sqlAccess";

// Per table version (its catalog updatedAt): the scan below reads every row of a column that turns out safe.
const verdicts: Map<string, string[]> = ((globalThis as any).__curfTextNumbers ??= new Map());

/**
 * Number columns of these tables that are physically TEXT and would misorder
 * as text, by table — empty on a DuckDB tenant. A column whose every value is
 * a plain unsigned integer of the same length (fiscal_year 2566–2568, a
 * zero-padded code) sorts the same as text or number, so it isn't one: a
 * query ordering by year works and isn't sent back.
 */
export async function textStoredNumbers(tenantId: string, tableNames: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (tableNames.length === 0 || (await ee.lake?.onPaidEngine(tenantId))) return out;
  const rows = await prisma.lakeTable.findMany({ where: { tenantId, name: { in: tableNames } }, select: { name: true, schemaJson: true, updatedAt: true } });
  const db = openLake(tenantId);
  for (const t of rows) {
    const key = `${tenantId}:${t.name}:${t.updatedAt.getTime()}`;
    let risky = verdicts.get(key);
    if (!risky) {
      const numbers = parseSchemaJson(t.schemaJson).filter((c) => c.type === "number").map((c) => c.name);
      const table = toSafeTableName(t.name);
      const declared = numbers.length ? storedColumnTypes(tenantId, t.name) : new Map<string, string>();
      // A column the engine computes (a formula column) isn't in table_info — it's typed by its expression.
      const text = numbers.filter((n) => declared.has(n) && (declared.get(n) === "TEXT" || declared.get(n) === ""));
      risky = text.filter((n) => {
        const c = `"${n.replace(/"/g, '""')}"`;
        const first = db.prepare(`SELECT LENGTH(${c}) AS n FROM "${table}" WHERE ${c} IS NOT NULL AND ${c} <> '' LIMIT 1`).get() as { n: number } | undefined;
        if (!first) return false;
        // Stops at the first value that isn't a digits-only string of that length.
        const odd = db.prepare(`SELECT 1 FROM "${table}" WHERE ${c} IS NOT NULL AND ${c} <> '' AND (${c} GLOB '*[^0-9]*' OR LENGTH(${c}) <> ?) LIMIT 1`).get(first.n);
        return !!odd;
      });
      verdicts.set(key, risky);
    }
    if (risky.length) out.set(t.name, risky);
  }
  return out;
}

/** The text-stored number columns a query reads, across the tenant's lake tables. */
export async function textStoredNumbersIn(tenantId: string, sql: string): Promise<string[]> {
  const names = (await prisma.lakeTable.findMany({ where: { tenantId }, select: { name: true } })).map((t) => t.name).filter((n) => referencesTable(sql, n));
  return [...new Set([...(await textStoredNumbers(tenantId, names)).values()].flat())];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The columns this SQL compares, orders or takes MIN/MAX of while they are
 * still text. A use inside CAST(…) is fine; so is a name the query itself
 * gives to something else (`SUM(budget) AS budget … ORDER BY budget`).
 */
export function textNumberMisuse(sql: string, columns: string[]): string[] {
  // Strings and CAST(...) calls hold nothing to flag; blank them out, keeping positions irrelevant.
  let s = sql.replace(/'(?:[^']|'')*'/g, "''");
  for (;;) {
    const m = /\bCAST\s*\(/i.exec(s);
    if (!m) break;
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")" && --depth === 0) break;
    }
    s = s.slice(0, m.index) + " 0 " + s.slice(i + 1);
  }
  const aliases = new Set([...s.matchAll(/\bAS\s+"?([A-Za-z_][\w]*)"?/gi)].map((m) => m[1]!.toLowerCase()));
  const hits: string[] = [];
  for (const col of columns) {
    if (aliases.has(col.toLowerCase())) continue;
    // The column, optionally table-qualified and quoted, not part of a longer name.
    const ref = `(?<![\\w."])(?:"?[A-Za-z_]\\w*"?\\.)?"?${esc(col)}"?(?![\\w"])`;
    // Order comparisons only: = and <> against text-stored numbers work (SQLite converts the literal to text).
    const compared = new RegExp(`${ref}\\s*(?:<=|>=|<(?!>)|>|\\bBETWEEN\\b)|(?:<=|>=|<|(?<!<)>)\\s*${ref}`, "i");
    const extreme = new RegExp(`\\b(?:MIN|MAX)\\s*\\(\\s*(?:DISTINCT\\s+)?${ref}\\s*\\)`, "i");
    const ordered = [...s.matchAll(/\bORDER\s+BY\s+([\s\S]*?)(?=\bLIMIT\b|\bOFFSET\b|\)|;|$)/gi)]
      .some((m) => m[1]!.split(",").some((item) => new RegExp(`^\\s*${ref}\\s*(?:ASC|DESC)?\\s*(?:NULLS\\s+(?:FIRST|LAST))?\\s*$`, "i").test(item)));
    if (compared.test(s) || extreme.test(s) || ordered) hits.push(col);
  }
  return hits;
}

/** What query_lake sends back for the model to write the query again. */
export function textNumberError(columns: string[]): string {
  const list = columns.map((c) => `"${c}"`).join(", ");
  return `Not run: ${list} ${columns.length === 1 ? "is a number column" : "are number columns"} stored as text in this lake, so comparing, ordering or taking MIN/MAX of ${columns.length === 1 ? "it" : "them"} as written would compare text ("10" before "6", "99" above "1000") and give a wrong answer. Wrap each use in CAST(column AS DOUBLE) — e.g. ORDER BY CAST(${columns[0]} AS DOUBLE) — and run it again. SUM and AVG are fine as they are.`;
}
