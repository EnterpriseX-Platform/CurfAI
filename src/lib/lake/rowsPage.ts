/**
 * A page of a lake table's rows for the spreadsheet view — any size of table.
 *
 * Keyset paging, not OFFSET: each page starts after the last row of the one
 * before (its sort value and rowid, in an opaque cursor), so page 5,000 of a
 * million-row table costs what page 1 does. Sorting is by the column's value
 * as its type reads it — "10" after "9" in a number column, though the lake
 * stores text — using the same typed read a formula makes of a column
 * (typedColumnSql), with blanks last either way. Find matches text anywhere
 * in a row's stored columns, case-insensitively — not in formula columns,
 * which are worked out from those (searching them worked every formula out
 * for every row scanned: 3.3× the time at a million rows).
 *
 * A sorted page sorts only each row's rowid and sort value, then fetches the
 * page's own rows by rowid — sorting whole rows (every column, formulas
 * worked out) for a table-wide ORDER BY cost 4–8× more at a million rows (audit 2026-09-30).
 *
 * Never a value the viewer can't see: rows are masked by the caller, and a
 * masked column is left out of find and can't be sorted by — either would
 * let someone probe what's under the mask by what comes back.
 */
import { typedColumnSql, quoteIdent, type Dialect } from "./formula/compile";
import { queryLake, toSafeTableName, type LakeColumn } from "./tables";
import { unusedKey } from "./resultKey";

export const MAX_PAGE_ROWS = 500;
/** A page that takes longer than this is stopped: at a million rows a sorted page takes 1–2 s. */
const PAGE_TIMEOUT_MS = 20_000;
const TOO_SLOW = "This table is too big to sort or search that way in time — try a narrower search.";
/** Each row's rowid comes back under this key — or a variant of it, if the table has a column called that (the result's `rowIdKey`). */
export const ROW_ID_KEY = "row id";
const SORT_KEY = "sort value";

export type RowsPageRequest = {
  tenantId: string;
  tableName: string;
  /** The table's columns (getTable). */
  columns: LakeColumn[];
  /** Columns masked for this viewer: not searched, not sortable. */
  masked: Set<string>;
  sort?: { column: string; dir: "asc" | "desc" };
  find?: string;
  cursor?: string;
  limit?: number;
};

/** A request the rows API can't serve, with a dict.ts key (sheet.err.*) and its parts for the page. */
export class RowsPageError extends Error {
  constructor(message: string, readonly key: string, readonly params: Record<string, string> = {}) { super(message); }
}

export async function rowsPage(req: RowsPageRequest): Promise<{ rows: Array<Record<string, unknown>>; next: string | null; rowIdKey: string }> {
  // Keys for the rowid and the sort value that no column of this table is
  // called, so neither replaces a real column's value (resultKey.ts).
  const names = req.columns.map((c) => c.name);
  const rowIdKey = unusedKey(ROW_ID_KEY, names);
  const sortKey = unusedKey(SORT_KEY, [...names, rowIdKey]);
  const limit = Math.min(MAX_PAGE_ROWS, Math.max(1, Math.floor(req.limit ?? 200)));
  const sort = req.sort;
  if (sort) {
    if (!req.columns.some((c) => c.name === sort.column)) throw new RowsPageError(`There's no column called ${sort.column}`, "sheet.err.noColumn", { col: sort.column });
    if (req.masked.has(sort.column)) throw new RowsPageError(`${sort.column} is masked for you, so the table can't be sorted by it`, "sheet.err.masked", { col: sort.column });
  }
  const after = req.cursor ? readCursor(req.cursor, !!sort) : null;
  const find = req.find?.trim().slice(0, 200) || "";

  const build = (dialect: Dialect) => {
    const inner: string[] = [];
    const where: string[] = [];
    const values: unknown[] = [];
    const sortCol = sort ? req.columns.find((c) => c.name === sort.column)! : null;
    // A formula column is stored as its type already; any other is read as its type.
    const sortExpr = sortCol ? (sortCol.formula ? quoteIdent(sortCol.name) : typedColumnSql(sortCol, dialect)) : null;
    if (find) {
      const searchable = req.columns.filter((c) => !req.masked.has(c.name) && !c.formula);
      const text = dialect === "duckdb" ? "VARCHAR" : "TEXT";
      const like = dialect === "duckdb" ? "ILIKE" : "LIKE";
      const pattern = `%${find.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      inner.push(`(${searchable.map((c) => `CAST(${quoteIdent(c.name)} AS ${text}) ${like} ? ESCAPE '\\'`).join(" OR ") || "FALSE"})`);
      values.push(...searchable.map(() => pattern));
    }
    const id = quoteIdent(rowIdKey);
    const key = quoteIdent(sortKey);
    if (after && sortExpr) {
      const cmp = sort!.dir === "desc" ? "<" : ">";
      if (after.value === null) {
        where.push(`(${key} IS NULL AND ${id} > ?)`);
        values.push(after.rowid);
      } else {
        where.push(`(${key} IS NULL OR ${key} ${cmp} ? OR (${key} = ? AND ${id} > ?))`);
        values.push(after.value, after.value, after.rowid);
      }
    } else if (after) {
      inner.push(`rowid > ?`);
      values.push(after.rowid);
    }
    const table = quoteIdent(toSafeTableName(req.tableName));
    const filter = inner.length ? ` WHERE ${inner.join(" AND ")}` : "";
    const paging = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    if (!sortExpr) {
      // Unsorted: straight on the table's own rowid order, which is indexed.
      return { sql: `SELECT rowid AS ${id}, * FROM ${table}${filter} ORDER BY rowid LIMIT ${limit + 1}`, values };
    }
    // Sorted, in two steps: sort just (rowid, sort value) and take the page,
    // then fetch those rows. The sort value is worked out once per row, in
    // the innermost query, and the paging condition and order read it by
    // name — written into them it was worked out three or four times a row.
    // SQLite would fold that query back in (and the repeats with it); a
    // LIMIT on it is what stops that.
    const dir = sort!.dir === "desc" ? "DESC" : "ASC";
    const keys = `SELECT ${id}, ${key} FROM (SELECT rowid AS ${id}, (${sortExpr}) AS ${key} FROM ${table}${filter}`
      + `${dialect === "sqlite" ? " LIMIT -1" : ""}) AS k${paging} ORDER BY ${key} IS NULL, ${key} ${dir}, ${id} LIMIT ${limit + 1}`;
    return {
      sql: `SELECT t.*, p.${id}, p.${key} FROM (${keys}) AS p JOIN ${table} AS t ON t.rowid = p.${id}`
        + ` ORDER BY p.${key} IS NULL, p.${key} ${dir}, p.${id}`,
      values,
    };
  };
  // Values bind the same way on both engines, so either statement takes them.
  const sqlite = build("sqlite");
  const duckdb = build("duckdb");
  // Off the event loop, with a limit: a sort or a find reads the whole table,
  // and anyone who can read it can ask for one (lakeWorker's reader processes).
  const got = await queryLake(req.tenantId, { sqlite: sqlite.sql, duckdb: duckdb.sql }, sqlite.values, {
    offMainThread: { timeoutMs: PAGE_TIMEOUT_MS, timeoutMessage: TOO_SLOW, cap: limit + 1, capMessage: TOO_SLOW },
  }).catch((e) => {
    if (e instanceof Error && e.message === TOO_SLOW) throw new RowsPageError(TOO_SLOW, "sheet.err.tooSlow");
    throw e;
  });

  const more = got.length > limit;
  const page = got.slice(0, limit);
  const last = page.at(-1);
  const next = more && last ? writeCursor(Number(last[rowIdKey]), sort ? plain(last[sortKey]) : undefined) : null;
  return {
    rows: page.map(({ [sortKey]: _sort, ...r }) => ({ ...r, [rowIdKey]: Number(r[rowIdKey]) })),
    next,
    rowIdKey,
  };
}

type Cursor = { rowid: number; value: string | number | boolean | null };

function plain(v: unknown): Cursor["value"] {
  if (v == null) return null;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return String(v);
}

function writeCursor(rowid: number, value: Cursor["value"] | undefined): string {
  return Buffer.from(JSON.stringify(value === undefined ? [rowid] : [rowid, value])).toString("base64url");
}

function readCursor(raw: string, sorted: boolean): Cursor {
  let v: unknown;
  try { v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); } catch { v = null; }
  if (!Array.isArray(v) || !Number.isSafeInteger(v[0]) || v.length !== (sorted ? 2 : 1)
    || (sorted && v[1] !== null && !["string", "number", "boolean"].includes(typeof v[1]))) {
    throw new RowsPageError("That page link is out of date — start from the top", "sheet.err.staleCursor");
  }
  return { rowid: v[0] as number, value: sorted ? (v[1] as Cursor["value"]) : null };
}
