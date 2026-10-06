/**
 * Spreadsheet-style formula evaluator for table columns.
 *
 * Wraps `expr-eval-fork` (2026-08-23: swapped from the original `expr-eval`,
 * which is unmaintained and carries two real CVEs — prototype pollution and
 * unrestricted functions passed to evaluate() — this fork exists
 * specifically to patch both; same Parser/Expression API, no code changes
 * needed beyond the import) with built-in helpers spreadsheet users expect:
 * SUM/AVG/MIN/MAX/COUNT over the WHOLE column, IF/AND/OR/NOT,
 * ABS/ROUND/CEIL/FLOOR, LEN/CONCAT.
 *
 * Two evaluation contexts:
 *
 *   - Per-row: each row's column values become bound variables. The row's
 *     `spend`, `leads`, `roi` are referenced by name. Aggregation helpers
 *     (SUM, AVG, …) read from the FULL column array, not the row, so
 *     `=spend / SUM(spend)` gives row-level share-of-total.
 *
 *   - Aggregate (totals row): expressions evaluated against the dataset
 *     directly. Useful for the table's footer.
 *
 * Why expr-eval(-fork) and not eval(): it has a fixed grammar with no JS
 * escape — there's no way for an author's formula string to call fetch()
 * or read globals. This is critical because formulas live in the report
 * definition, which means a malicious user could inject a formula that
 * runs on every viewer's browser. The sandbox prevents that.
 */
import { Parser, type Expression } from "expr-eval-fork";
import type { Row } from "@/lib/reporting/interpolate";

export type FormulaResult = number | string | boolean | null;

/**
 * Compile a formula once. Throws on syntax errors so callers can show a
 * #SYNTAX! cell value with the error message in the tooltip.
 */
export function compileFormula(formula: string): Expression {
  const parser = makeParser();
  // Strip a leading "=" — Excel users habitually write "=A+B"; we accept
  // both with and without.
  const src = formula.trim().replace(/^=+/, "");
  return parser.parse(src);
}

/**
 * Evaluate a compiled expression against a single row plus the FULL
 * dataset (so column-level aggregations like SUM(spend) work). Returns
 * { value } on success or { error } on runtime failure.
 */
export function evaluateRow(
  expr: Expression,
  row: Row,
  allRows: Row[],
): { value: FormulaResult; error?: undefined } | { value: null; error: string } {
  try {
    registerHelpers(expr, allRows);
    const ctx = makeRowContext(row);
    const v = expr.evaluate(ctx);
    return { value: normalize(v) };
  } catch (e: any) {
    return { value: null, error: e?.message ?? "Evaluation error" };
  }
}

/**
 * Evaluate against the WHOLE dataset (no per-row binding) — for the
 * footer/totals row. Falls back to evaluating with an empty row if the
 * formula references row-level fields the totals row can't satisfy.
 */
export function evaluateAggregate(
  expr: Expression,
  allRows: Row[],
): { value: FormulaResult; error?: undefined } | { value: null; error: string } {
  try {
    registerHelpers(expr, allRows);
    const v = expr.evaluate({});
    return { value: normalize(v) };
  } catch (e: any) {
    return { value: null, error: e?.message ?? "Evaluation error" };
  }
}

// ---------------------------------------------------------------------------
// Context + function registration
// ---------------------------------------------------------------------------

/**
 * Bind every column name as a row-local variable. Nothing else goes in
 * here — expr-eval-fork's security fix for GHSA-jc85-fpwf-qm7x ("does not
 * restrict functions passed to the evaluate function") means a plain
 * function sitting in the evaluate() values object is no longer callable
 * at all; it throws "Variable references an unallowed function". Helpers
 * must be registered on the Expression's own `functions` map instead — see
 * registerHelpers() below.
 */
function makeRowContext(row: Row): Record<string, any> {
  const ctx: Record<string, any> = {};
  for (const k of Object.keys(row)) {
    const v = row[k];
    // Try to coerce numeric strings — spreadsheets do this implicitly
    // and authors will be confused otherwise ("3" + "5" = "35" is wrong here).
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    ctx[k] = (typeof n === "number" && Number.isFinite(n)) ? n : v;
  }
  return ctx;
}

/**
 * Register every helper (aggregation + math + string + logic) directly on
 * the compiled Expression's `functions` map, which is expr-eval-fork's
 * actual allowlist mechanism (undocumented in its public .d.ts, but a
 * stable, intentional public property — see Parser.functions in
 * node_modules/expr-eval-fork/parser.d.ts). A function reachable only via
 * evaluate()'s values object is rejected; one sitting on `expr.functions`
 * is exactly how the library expects a host application to expose safe,
 * pre-vetted functions to untrusted formula text. Re-registered on every
 * call since the aggregation helpers close over `allRows`, which can
 * differ per report even when the compiled Expression (cached via
 * compileFormula) is reused.
 */
function registerHelpers(expr: Expression, allRows: Row[]): void {
  const target = (expr as any).functions ?? ((expr as any).functions = {});
  Object.assign(target, makeAggregationHelpers(allRows), MATH_HELPERS, STRING_HELPERS, LOGIC_HELPERS);
}

/**
 * SUM/AVG/MIN/MAX/COUNT/COUNTA over a column name. Each helper takes a
 * column name STRING and reads it from the closed-over dataset.
 *
 * Why not pass the array literal: expr-eval doesn't have a great syntax
 * for "all values of column X" — `SUM([spend])` parses as a row of
 * single-element arrays. Naming the column as a string is what
 * spreadsheet users mean by `=SUM(B:B)` so the mental model holds.
 */
function makeAggregationHelpers(rows: Row[]) {
  const num = (col: string): number[] => rows
    .map((r) => Number(r[col]))
    .filter((n) => Number.isFinite(n));
  return {
    SUM:    (col: string) => num(col).reduce((a, b) => a + b, 0),
    AVG:    (col: string) => { const a = num(col); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; },
    MIN:    (col: string) => { const a = num(col); return a.length ? Math.min(...a) : 0; },
    MAX:    (col: string) => { const a = num(col); return a.length ? Math.max(...a) : 0; },
    MEDIAN: (col: string) => {
      const a = [...num(col)].sort((x, y) => x - y);
      if (a.length === 0) return 0;
      const m = Math.floor(a.length / 2);
      return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    },
    /** COUNT — only counts numeric cells (matches Excel COUNT). */
    COUNT:  (col: string) => num(col).length,
    /** COUNTA — counts non-null/non-empty cells regardless of type. */
    COUNTA: (col: string) => rows.filter((r) => r[col] !== null && r[col] !== undefined && r[col] !== "").length,
  };
}

const MATH_HELPERS = {
  ABS:   Math.abs,
  ROUND: (x: number, d = 0) => Math.round(x * Math.pow(10, d)) / Math.pow(10, d),
  CEIL:  Math.ceil,
  FLOOR: Math.floor,
  SQRT:  Math.sqrt,
  POW:   Math.pow,
  EXP:   Math.exp,
  LN:    Math.log,
  LOG10: Math.log10,
  // Spreadsheet alias — Excel exposes `LOG` as base-10 by default.
  LOG:   Math.log10,
  PI:    Math.PI,
};

const STRING_HELPERS = {
  LEN:    (s: any) => String(s ?? "").length,
  LOWER:  (s: any) => String(s ?? "").toLowerCase(),
  UPPER:  (s: any) => String(s ?? "").toUpperCase(),
  TRIM:   (s: any) => String(s ?? "").trim(),
  CONCAT: (...args: any[]) => args.map((a) => a ?? "").join(""),
  // Excel's IFS-style helper. (a, b, c, d, ...) → if a then b else if c then d ...
  // Lets authors avoid nesting IF()s.
};

const LOGIC_HELPERS = {
  IF:  (cond: any, a: any, b: any) => (cond ? a : b),
  AND: (...xs: any[]) => xs.every(Boolean),
  OR:  (...xs: any[]) => xs.some(Boolean),
  NOT: (x: any) => !x,
  // EQ / NE / GT / LT — useful inside IF() when authors don't want to
  // remember expr-eval's operator precedence quirks.
  EQ:  (a: any, b: any) => a === b,
  NE:  (a: any, b: any) => a !== b,
  GT:  (a: any, b: any) => Number(a) >  Number(b),
  LT:  (a: any, b: any) => Number(a) <  Number(b),
};

// ---------------------------------------------------------------------------
// Parser configuration
// ---------------------------------------------------------------------------

/**
 * expr-eval Parser with a few features enabled:
 *   - logical: `and` / `or` / `not` (word form) and `!` — NOT `&&`/`||`,
 *     which this grammar has never tokenized (verified 2026-08-23 against
 *     both expr-eval and expr-eval-fork; a stale comment here previously
 *     claimed `&&`/`||` worked). Authors write `spend > 1000 and roi > 3`,
 *     or use the AND()/OR()/NOT() functions below — both work today.
 *   - comparison: > >= < <= == !=
 *
 * Disabled: assignment ('=' is reserved as the formula prefix anyway).
 */
function makeParser(): Parser {
  return new Parser({
    operators: {
      add: true, subtract: true, multiply: true, divide: true,
      remainder: true, power: true,
      logical: true, comparison: true,
      conditional: true,    // a ? b : c
      assignment: false,    // no
      in: false,
    } as any,
  });
}

// ---------------------------------------------------------------------------
// Scalar formulas — What-if driver models
// ---------------------------------------------------------------------------

/**
 * The same sandboxed grammar, narrowed for What-if outputs, which must be a
 * pure function of their named inputs: no member access, no column
 * aggregates or string helpers, and none of the parser's own array or
 * non-deterministic functions. Disabling the `random` operator option does
 * NOT remove the `random()` function (verified against expr-eval-fork
 * 3.0.3), so the parser's function table is stripped to an allowlist here
 * rather than trusted to its options.
 */
export const SCALAR_FORMULA_MAX_LENGTH = 300;

const SCALAR_PARSER_FUNCTIONS = new Set(["min", "max", "pow", "hypot", "atan2"]);

const SCALAR_HELPERS: Record<string, unknown> = {
  ...MATH_HELPERS,
  ...LOGIC_HELPERS,
  MIN: (...xs: number[]) => Math.min(...xs),
  MAX: (...xs: number[]) => Math.max(...xs),
};

/** Function names a scalar formula may call; everything else it names must be a declared variable. */
export const SCALAR_FUNCTION_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(SCALAR_HELPERS),
  ...SCALAR_PARSER_FUNCTIONS,
]);

/**
 * Words a variable must not be named, compared lower-cased. The parser reads
 * these as operators, functions or constants before it ever treats a word as
 * a variable — a driver called `round` or `not` would silently become an
 * operator, one called `e` or `pi` a constant.
 */
export const SCALAR_RESERVED_NAMES: ReadonlySet<string> = (() => {
  const p = new Parser() as any;
  const words = [
    ...Object.keys(p.unaryOps ?? {}),
    ...Object.keys(p.binaryOps ?? {}),
    ...Object.keys(p.ternaryOps ?? {}),
    ...Object.keys(p.functions ?? {}),
    ...Object.keys(p.consts ?? {}),
    ...Object.keys(SCALAR_HELPERS),
    ...Object.keys(STRING_HELPERS),
    "and", "or", "not", "in", "true", "false", "e", "pi",
  ];
  return new Set(words.filter((w) => /^[a-z]/i.test(w)).map((w) => w.toLowerCase()));
})();

function makeScalarParser(): Parser {
  const p = new Parser({
    allowMemberAccess: false,
    operators: {
      add: true, subtract: true, multiply: true, divide: true,
      remainder: true, power: true,
      logical: true, comparison: true, conditional: true,
      assignment: false, fndef: false, in: false,
      concatenate: false, factorial: false, length: false, random: false,
    } as any,
  });
  const fns = (p as any).functions as Record<string, unknown>;
  for (const name of Object.keys(fns)) {
    if (!SCALAR_PARSER_FUNCTIONS.has(name)) delete fns[name];
  }
  return p;
}

/** Compile a What-if formula. Throws on an empty, over-long or unparsable formula. */
export function compileScalarFormula(formula: string): Expression {
  const src = formula.trim().replace(/^=+/, "");
  if (src === "") throw new Error("Formula is empty");
  if (src.length > SCALAR_FORMULA_MAX_LENGTH) {
    throw new Error(`Formula is longer than ${SCALAR_FORMULA_MAX_LENGTH} characters`);
  }
  return makeScalarParser().parse(src);
}

/**
 * Evaluate a compiled scalar formula against named numbers. Returns null for
 * anything that isn't a finite number — divide-by-zero, NaN, a name with no
 * value — so callers show "unavailable" rather than a misleading 0.
 */
export function evaluateScalar(expr: Expression, vars: Record<string, number>): number | null {
  try {
    const target = (expr as any).functions ?? ((expr as any).functions = {});
    Object.assign(target, SCALAR_HELPERS);
    const v = expr.evaluate({ ...vars });
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    return Object.is(v, -0) ? 0 : v;
  } catch {
    return null;
  }
}

function normalize(v: unknown): FormulaResult {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") {
    // expr-eval can produce -0 / NaN / Infinity — normalize for display.
    if (!Number.isFinite(v)) return null;
    if (Object.is(v, -0)) return 0;
    return v;
  }
  if (typeof v === "string" || typeof v === "boolean") return v;
  // Anything else (object, array) — stringify defensively.
  return String(v);
}
