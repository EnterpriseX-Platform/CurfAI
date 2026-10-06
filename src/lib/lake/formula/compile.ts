/**
 * Formula columns — from the tree parse.ts builds to the SQL a lake column
 * is defined with, for either engine (SQLite, the default; DuckDB, the paid
 * one), checking as it goes that every name is one of the table's columns or
 * a function below, and that the types fit.
 *
 * The SQL is built here, piece by piece, never copied from the formula:
 * names are always quoted by quoteIdent, text is always a single-quoted
 * literal with its quotes doubled, numbers match a strict pattern. Nothing a
 * person types can become SQL of its own.
 *
 * The same formula gives the same answer on both engines — the reason for
 * the casts below: the SQLite lake stores every value as text, DuckDB types
 * them, and each engine treats a bad number, a division by zero and a
 * missing value its own way unless told otherwise.
 *
 * Pure: no server imports, so the formula editor can check as you type.
 */
import { FormulaError, parseFormula, type BinOp, type Node } from "./parse";

export type Dialect = "sqlite" | "duckdb";
/** The types a formula works in. A column the lake couldn't type is "any": it fits wherever it's used. */
export type FormulaType = "number" | "text" | "date" | "boolean";
type Typed = FormulaType | "any";

/** A column a formula may use; `formula` is set when it is itself a formula column. */
export type FormulaColumn = { name: string; type: string; formula?: string | null };

export type CompiledFormula = {
  /** The column's SQL expression, for this dialect. */
  sql: string;
  /** What it gives. */
  type: FormulaType;
  /** The columns it reads, as they're named in the table. */
  uses: string[];
};

type Fn = {
  sig: string;
  does: string;
  min: number;
  max: number;
  /** One per argument; the last repeats for functions that take several. "any" takes anything. */
  args: Array<Typed>;
  /** What it gives; "same" = the common type of its value arguments (IF's then/else, COALESCE's values). */
  ret: FormulaType | "same";
  sql: (a: string[], d: Dialect) => string;
};

const text = (d: Dialect) => (d === "sqlite" ? "TEXT" : "VARCHAR");
/**
 * Smallest/largest, skipping empty values on both engines (SQLite's min()
 * gives no value if any argument is empty; DuckDB's least() skips them):
 * each argument falls back to the others, which can't change the answer.
 */
const minmax = (a: string[], fn: string) =>
  `${fn}(${a.map((x, i) => `COALESCE(${[x, ...a.filter((_, j) => j !== i)].join(", ")})`).join(", ")})`;

/** Every function a formula may call — the list the editor shows and the AI is given. */
export const FORMULA_FUNCTIONS: Record<string, Fn> = {
  ROUND: { sig: "ROUND(number, digits)", does: "Round to a number of decimal places (0 if left out)", min: 1, max: 2, args: ["number", "number"], ret: "number",
    sql: ([x, n]) => `ROUND(${x}, CAST(${n ?? "0"} AS INTEGER))` },
  ABS: { sig: "ABS(number)", does: "The number without its sign", min: 1, max: 1, args: ["number"], ret: "number", sql: ([x]) => `ABS(${x})` },
  MIN: { sig: "MIN(number, number, …)", does: "The smallest, ignoring empty values", min: 2, max: 9, args: ["number"], ret: "number",
    sql: (a, d) => minmax(a, d === "sqlite" ? "min" : "least") },
  MAX: { sig: "MAX(number, number, …)", does: "The largest, ignoring empty values", min: 2, max: 9, args: ["number"], ret: "number",
    sql: (a, d) => minmax(a, d === "sqlite" ? "max" : "greatest") },
  IF: { sig: "IF(test, then, else)", does: "One value when the test is true, another when it isn't", min: 3, max: 3, args: ["boolean", "any", "any"], ret: "same",
    sql: ([c, a, b]) => `(CASE WHEN ${c} THEN ${a} ELSE ${b} END)` },
  AND: { sig: "AND(test, test, …)", does: "True when every test is", min: 2, max: 9, args: ["boolean"], ret: "boolean", sql: (a) => `(${a.join(" AND ")})` },
  OR: { sig: "OR(test, test, …)", does: "True when any test is", min: 2, max: 9, args: ["boolean"], ret: "boolean", sql: (a) => `(${a.join(" OR ")})` },
  NOT: { sig: "NOT(test)", does: "The opposite of a test", min: 1, max: 1, args: ["boolean"], ret: "boolean", sql: ([x]) => `(NOT ${x})` },
  ISBLANK: { sig: "ISBLANK(value)", does: "True when the value is empty", min: 1, max: 1, args: ["any"], ret: "boolean",
    sql: ([x], d) => `(${x} IS NULL OR CAST(${x} AS ${text(d)}) = '')` },
  COALESCE: { sig: "COALESCE(value, fallback, …)", does: "The first value that isn't empty", min: 2, max: 9, args: ["any"], ret: "same",
    sql: (a) => `COALESCE(${a.join(", ")})` },
  YEAR: { sig: "YEAR(date)", does: "The year of a date", min: 1, max: 1, args: ["date"], ret: "number",
    sql: ([x], d) => (d === "sqlite" ? `CAST(strftime('%Y', ${x}) AS INTEGER)` : `year(${x})`) },
  MONTH: { sig: "MONTH(date)", does: "The month of a date, 1–12", min: 1, max: 1, args: ["date"], ret: "number",
    sql: ([x], d) => (d === "sqlite" ? `CAST(strftime('%m', ${x}) AS INTEGER)` : `month(${x})`) },
  DAY: { sig: "DAY(date)", does: "The day of the month, 1–31", min: 1, max: 1, args: ["date"], ret: "number",
    sql: ([x], d) => (d === "sqlite" ? `CAST(strftime('%d', ${x}) AS INTEGER)` : `day(${x})`) },
  DAYS: { sig: "DAYS(end_date, start_date)", does: "Days from the start date to the end date", min: 2, max: 2, args: ["date", "date"], ret: "number",
    sql: ([e, s], d) => (d === "sqlite" ? `CAST(ROUND(julianday(${e}) - julianday(${s})) AS INTEGER)` : `date_diff('day', ${s}, ${e})`) },
  LEFT: { sig: "LEFT(text, count)", does: "The first characters of a text", min: 2, max: 2, args: ["text", "number"], ret: "text",
    sql: ([x, n], d) => (d === "sqlite" ? `substr(${x}, 1, MAX(CAST(${n} AS INTEGER), 0))` : `left(${x}, CAST(${n} AS INTEGER))`) },
  RIGHT: { sig: "RIGHT(text, count)", does: "The last characters of a text", min: 2, max: 2, args: ["text", "number"], ret: "text",
    sql: ([x, n], d) => (d === "sqlite" ? `(CASE WHEN CAST(${n} AS INTEGER) > 0 THEN substr(${x}, -CAST(${n} AS INTEGER)) ELSE '' END)` : `right(${x}, CAST(${n} AS INTEGER))`) },
  UPPER: { sig: "UPPER(text)", does: "In capital letters", min: 1, max: 1, args: ["text"], ret: "text", sql: ([x]) => `upper(${x})` },
  LOWER: { sig: "LOWER(text)", does: "In small letters", min: 1, max: 1, args: ["text"], ret: "text", sql: ([x]) => `lower(${x})` },
  TRIM: { sig: "TRIM(text)", does: "Without spaces at either end", min: 1, max: 1, args: ["text"], ret: "text", sql: ([x]) => `trim(${x})` },
  LEN: { sig: "LEN(text)", does: "How many characters", min: 1, max: 1, args: ["text"], ret: "number", sql: ([x]) => `length(${x})` },
  CONTAINS: { sig: "CONTAINS(text, part)", does: "True when the text has the part in it, ignoring case", min: 2, max: 2, args: ["text", "text"], ret: "boolean",
    sql: ([x, p]) => `(instr(lower(${x}), lower(${p})) > 0)` },
  CONCAT: { sig: "CONCAT(text, text, …)", does: "Join texts together (the same as &)", min: 2, max: 9, args: ["text"], ret: "text",
    sql: (a) => `(${a.map((x) => `COALESCE(${x}, '')`).join(" || ")})` },
};

/** The longest SQL a formula may compile to — far past any real formula (a MIN over nine columns is under 10,000 on SQLite). */
export const MAX_SQL_LENGTH = 50_000;

/** Functions a column can't hold: their answer changes on its own, and a stored column must give the same answer every time. */
const CHANGING = new Set(["TODAY", "NOW", "RAND", "RANDOM", "RANDBETWEEN", "UUID"]);

/** SQL identifier quoting — the one way a column name reaches SQL. */
export function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}
const quoteText = (s: string) => `'${s.replace(/'/g, "''")}'`;

function columnType(t: string): Typed {
  return t === "number" || t === "text" || t === "date" || t === "boolean" ? t : "any";
}


export function compileFormula(
  src: string,
  opts: { columns: FormulaColumn[]; dialect: Dialect; /** The formula column being edited: it can't use itself, directly or through another formula. */ self?: string },
): CompiledFormula {
  const tree = parseFormula(src);
  const { columns, dialect: d } = opts;
  const uses = new Set<string>();

  function resolve(name: string, at: number): FormulaColumn {
    const col = columns.find((c) => c.name === name) ?? (() => {
      const loose = columns.filter((c) => c.name.toLowerCase() === name.toLowerCase());
      return loose.length === 1 ? loose[0] : undefined;
    })();
    if (!col || col.name === opts.self) {
      if (col && col.name === opts.self) throw new FormulaError("self_reference", at, { name });
      const near = closest(name, columns.map((c) => c.name).filter((n) => n !== opts.self));
      throw new FormulaError(near ? "unknown_column_near" : "unknown_column", at, near ? { name, near } : { name });
    }
    if (opts.self && col.formula && dependsOn(col, opts.self, columns)) {
      throw new FormulaError("circular", at, { col: col.name, self: opts.self });
    }
    return col;
  }

  /** A column's value, read as `want`. The only place a column name becomes SQL. */
  function readColumn(col: FormulaColumn, want: Typed, at: number): { sql: string; type: Typed } {
    const q = quoteIdent(col.name);
    const has = columnType(col.type);
    if (want === "any") return { sql: q, type: has };
    if (want === "number") {
      if (has === "text" || has === "date" || has === "boolean") throw new FormulaError(`col_not_number_${has}`, at, { col: col.name });
      return { sql: asNumber(q, d), type: "number" };
    }
    if (want === "date") {
      if (has === "number" || has === "boolean") throw new FormulaError("col_not_date", at, { col: col.name, type: has });
      return { sql: asDate(q, d), type: "date" };
    }
    if (want === "text") return { sql: has === "text" ? q : `CAST(${q} AS ${text(d)})`, type: "text" };
    // boolean
    if (has === "boolean" || has === "any") return { sql: asBoolean(q, d), type: "boolean" };
    throw new FormulaError("col_not_test", at, { col: col.name, type: has });
  }

  /** Compile `n`, read as `want` ("any" = as it is). */
  function emit(n: Node, want: Typed): { sql: string; type: Typed } {
    const got = build(n, want);
    // Checked at every node, as it's built: MIN/MAX, ISBLANK and RIGHT write
    // an argument out more than once, so nesting them grows the SQL
    // exponentially — a 1,000-character formula could otherwise take the
    // server's memory and CPU (audit 2026-09-30, S6).
    if (got.sql.length > MAX_SQL_LENGTH) throw new FormulaError("too_complex", n.at);
    if (want === "any" || got.type === want) return got;
    if (got.type === "any") return got;
    if (want === "text") return { sql: `CAST(${got.sql} AS ${text(d)})`, type: "text" };
    throw new FormulaError("gives_wrong", n.at, { typeA: got.type, typeB: want });
  }

  function build(n: Node, want: Typed): { sql: string; type: Typed } {
    switch (n.k) {
      case "num":
        // parse.ts only lets digits and one point through; "5." and ".5" are written out in full.
        return { sql: (n.v.startsWith(".") ? `0${n.v}` : n.v).replace(/\.$/, ""), type: "number" };
      case "str":
        if (want === "date") {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(n.v) || Number.isNaN(Date.parse(n.v))) {
            throw new FormulaError("bad_date", n.at, { text: n.v });
          }
          return { sql: d === "sqlite" ? quoteText(n.v) : `DATE ${quoteText(n.v)}`, type: "date" };
        }
        return { sql: quoteText(n.v), type: "text" };
      case "bool":
        return { sql: d === "sqlite" ? (n.v ? "1" : "0") : (n.v ? "TRUE" : "FALSE"), type: "boolean" };
      case "col": {
        const col = resolve(n.name, n.at);
        uses.add(col.name);
        return readColumn(col, want, n.at);
      }
      case "neg": {
        const a = emit(n.a, "number");
        return { sql: `(-${a.sql})`, type: "number" };
      }
      case "bin":
        return binary(n.op, n.a, n.b, n.at);
      case "call":
        return call(n);
    }
  }

  function binary(op: BinOp, an: Node, bn: Node, at: number): { sql: string; type: Typed } {
    if (op === "&") {
      const a = emit(an, "text"), b = emit(bn, "text");
      return { sql: `(COALESCE(${a.sql}, '') || COALESCE(${b.sql}, ''))`, type: "text" };
    }
    if (op === "+" || op === "-" || op === "*" || op === "/") {
      const a = arithmetic(an, op), b = arithmetic(bn, op);
      if (op === "/") return { sql: `(${d === "sqlite" ? `CAST(${a} AS REAL)` : a} / NULLIF(${b}, 0))`, type: "number" };
      return { sql: `(${a} ${op} ${b})`, type: "number" };
    }
    // Comparison: both sides read as one type — the first side's, unless it's a literal or untyped.
    const common = compareType(an, bn, at);
    const a = emit(an, common), b = emit(bn, common);
    return { sql: `(${a.sql} ${op} ${b.sql})`, type: "boolean" };
  }

  function arithmetic(n: Node, op: string): string {
    // A column says what it is and how to fix it (readColumn); anything else gets the operator's rule.
    if (n.k === "col") return emit(n, "number").sql;
    const probe = peekType(n);
    if (probe === "text") throw new FormulaError("text_arith", n.at, { op });
    if (probe === "date") throw new FormulaError("date_arith", n.at, { op });
    if (probe === "boolean") throw new FormulaError("test_arith", n.at, { op });
    return emit(n, "number").sql;
  }

  function compareType(a: Node, b: Node, at: number): Typed {
    const ta = peekType(a), tb = peekType(b);
    if (ta === "any" && tb === "any") return "text";
    if (ta === "any") return tb;
    if (tb === "any") return ta;
    if (ta === tb) return ta;
    // "2024-01-01" against a date column is a date.
    if (ta === "date" && b.k === "str") return "date";
    if (tb === "date" && a.k === "str") return "date";
    throw new FormulaError("cant_compare", at, { typeA: ta, typeB: tb });
  }

  /** What a node gives, without emitting it — for choosing how to read the other side of an operator. */
  function peekType(n: Node): Typed {
    switch (n.k) {
      case "num": return "number";
      case "str": return "text";
      case "bool": return "boolean";
      case "col": {
        const col = columns.find((c) => c.name === n.name) ?? columns.find((c) => c.name.toLowerCase() === n.name.toLowerCase());
        return col ? columnType(col.type) : "any";
      }
      case "neg": return "number";
      case "bin": return n.op === "&" ? "text" : "+-*/".includes(n.op) ? "number" : "boolean";
      case "call": {
        const f = FORMULA_FUNCTIONS[n.fn];
        if (!f) return "any";
        if (f.ret !== "same") return f.ret;
        const vals = n.fn === "IF" ? n.args.slice(1) : n.args;
        return vals.map(peekType).find((t) => t !== "any") ?? "any";
      }
    }
  }

  function call(n: Extract<Node, { k: "call" }>): { sql: string; type: Typed } {
    const f = FORMULA_FUNCTIONS[n.fn];
    if (!f) {
      if (CHANGING.has(n.fn)) throw new FormulaError("changing_function", n.at, { fn: n.fn });
      const near = closest(n.fn, Object.keys(FORMULA_FUNCTIONS));
      throw new FormulaError(near ? "unknown_function_near" : "unknown_function", n.at, near ? { fn: n.fn, near } : { fn: n.fn });
    }
    if (n.args.length < f.min || n.args.length > f.max) {
      const key = f.min === f.max ? (f.min === 1 ? "arity_one" : "arity_exact") : f.max >= 9 ? "arity_min" : "arity_range";
      throw new FormulaError(key, n.at, { fn: n.fn, sig: f.sig, n: f.min, min: f.min, max: f.max });
    }
    if (f.ret === "same") {
      const vals = n.fn === "IF" ? n.args.slice(1) : n.args;
      const types = vals.map(peekType).filter((t) => t !== "any");
      const target: Typed = types[0] ?? "any";
      const clash = types.find((t) => t !== target);
      if (clash) {
        throw new FormulaError(n.fn === "IF" ? "if_mixed" : "values_mixed", n.at, { fn: n.fn, typeA: target, typeB: clash });
      }
      const sqlArgs = n.args.map((a, i) => emit(a, n.fn === "IF" && i === 0 ? "boolean" : target).sql);
      return { sql: f.sql(sqlArgs, d), type: target };
    }
    const sqlArgs = n.args.map((a, i) => emit(a, f.args[Math.min(i, f.args.length - 1)]!).sql);
    return { sql: f.sql(sqlArgs, d), type: f.ret };
  }

  // Read the whole formula as the type it gives, so a bare typed column
  // (`revenue`) is cast like any other use of it rather than stored raw.
  const rootType = peekType(tree);
  const out = emit(tree, rootType);
  const type: FormulaType = out.type === "any" ? "text" : out.type;
  return { sql: out.sql, type, uses: [...uses] };
}

/** Is `col` worked out, directly or through other formula columns, from `target`? */
function dependsOn(col: FormulaColumn, target: string, columns: FormulaColumn[], seen = new Set<string>()): boolean {
  if (!col.formula || seen.has(col.name)) return false;
  seen.add(col.name);
  let refs: string[];
  try { refs = compileFormula(col.formula, { columns: columns.filter((c) => c.name !== col.name), dialect: "sqlite" }).uses; } catch { return false; }
  return refs.some((r) => r === target || dependsOn(columns.find((c) => c.name === r) ?? { name: r, type: "any" }, target, columns, seen));
}

/**
 * A column's value read as its type, the way a formula reads it — what the
 * spreadsheet view sorts by, since the lake keeps a number column's values
 * as text and "10" has to come after "9".
 */
export function typedColumnSql(col: FormulaColumn, d: Dialect): string {
  const q = quoteIdent(col.name);
  switch (columnType(col.type)) {
    case "number": return asNumber(q, d);
    case "date": return asDate(q, d);
    case "boolean": return asBoolean(q, d);
    default: return q;
  }
}

function asNumber(q: string, d: Dialect): string {
  // SQLite reads "abc" as 0; DuckDB's TRY_CAST gives no value. Both give no value here.
  return d === "sqlite"
    ? `(CASE WHEN trim(${q}) = '' OR trim(${q}) GLOB '*[^0-9.eE+-]*' THEN NULL ELSE CAST(${q} AS REAL) END)`
    : `TRY_CAST(${q} AS DOUBLE)`;
}

function asDate(q: string, d: Dialect): string {
  // SQLite's date() gives no value for anything that isn't a date, as DuckDB's TRY_CAST does.
  return d === "sqlite" ? `date(${q})` : `TRY_CAST(${q} AS DATE)`;
}

function asBoolean(q: string, d: Dialect): string {
  return `(lower(CAST(${q} AS ${text(d)})) IN ('1', 'true', 'yes', 'y'))`;
}

/** The engine type a formula column is declared with. */
export function storageType(t: FormulaType, d: Dialect): string {
  if (d === "sqlite") return t === "number" ? "REAL" : t === "boolean" ? "INTEGER" : "TEXT";
  return t === "number" ? "DOUBLE" : t === "boolean" ? "BOOLEAN" : t === "date" ? "DATE" : "VARCHAR";
}

/** The nearest name, when the typo is small enough to be worth suggesting. */
function closest(word: string, names: string[]): string | null {
  const w = word.toLowerCase();
  let best: string | null = null;
  let bestD = Math.max(2, Math.floor(w.length / 3)) + 1;
  for (const n of names) {
    const d = distance(w, n.toLowerCase());
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}
