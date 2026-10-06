/**
 * The single DDL/DML guard shared by every driver (sqlite, postgres, mysql,
 * snowflake, bigquery) — every query the runner executes goes through this
 * before it reaches a real connection. Exported so it can be unit-tested
 * directly rather than only indirectly through a live DB connection.
 *
 * Lives in its own zero-dependency module (not runner.ts) so that
 * lib/reporting/schema.ts can call it from a Zod `.refine()` to reject
 * write/DDL SQL at *save* time too, without pulling runner.ts's native DB
 * drivers (better-sqlite3, pg, mysql2, ...) into schema.ts's dependency
 * graph — schema.ts is imported by client-side code (the Designer store).
 */
// Top-level write/DDL/side-effect keywords. A word-boundary regex over the
// raw string used to be enough, but a "--" inside a string literal
// (SELECT '--' AS a; DROP …) hid everything after it from the check, and pg's
// simple protocol then ran the smuggled statement. We tokenize instead
// (tokenizeSql knows strings from comments), so a keyword or ";" inside a
// string is a "string" token that can't pose as SQL, and "createdAt" stays
// one "word" that never matches "create".
const FORBIDDEN_KEYWORDS = new Set([
  "insert", "update", "delete", "drop", "alter", "create", "replace",
  "truncate", "attach", "detach", "pragma", "vacuum", "reindex",
  "exec", "execute", "merge", "grant", "revoke",
  // "into" catches MySQL's SELECT...INTO OUTFILE/DUMPFILE (arbitrary file
  // write) and Postgres's SELECT...INTO new_table (smuggled DDL) — neither
  // is legitimate in a read-only report query.
  "into",
]);

export function assertSelectOnly(sql: string) {
  // lenientQuotes so MySQL backtick and DuckDB [] identifiers tokenize as
  // punctuation rather than being rejected outright — this guard runs for
  // every driver, not just the ANSI-quoting ones.
  const toks = tokenizeSql(sql, { lenientQuotes: true });
  if (toks.length === 0) throw new Error("SQL validation failed: empty query");

  // Must begin with SELECT or WITH (CTE).
  if (!isWord(toks[0], "select") && !isWord(toks[0], "with")) {
    throw new Error("SQL validation failed: only SELECT (or WITH ... SELECT) statements are allowed");
  }

  // No write/DDL keyword anywhere — as a real word token, so one inside a
  // string literal or spelled as part of an identifier ("insertions") can't
  // match, while "WITH x AS (DELETE …)" still does.
  if (toks.some((t) => t.kind === "word" && FORBIDDEN_KEYWORDS.has(t.value))) {
    throw new Error("SQL validation failed: write or DDL statements are not allowed");
  }

  // A ";" with any statement after it is multiple statements. A trailing
  // ";" (nothing but it left) is fine.
  const semi = toks.findIndex((t) => t.kind === "punct" && t.value === ";");
  if (semi !== -1 && semi < toks.length - 1) {
    throw new Error("SQL validation failed: multiple statements are not allowed");
  }
}

// ---------------------------------------------------------------------------
// Model-written SQL
// ---------------------------------------------------------------------------

/** Pure scalar, aggregate, date and window functions. Nothing here can
 *  read a file, reach the network, or look outside the query's own rows. */
const COMPOSED_SQL_FUNCTIONS = new Set([
  "count", "sum", "avg", "min", "max", "total", "group_concat", "string_agg", "median",
  "abs", "round", "ceil", "ceiling", "floor", "sign", "mod", "power", "sqrt",
  "coalesce", "ifnull", "nullif", "iif", "cast", "greatest", "least",
  "lower", "upper", "trim", "ltrim", "rtrim", "length", "substr", "substring", "instr", "concat",
  "date", "strftime", "julianday", "date_trunc", "date_part", "extract", "year", "month", "day",
  "row_number", "rank", "dense_rank", "ntile", "lag", "lead", "first_value", "last_value",
  "percent_rank", "cume_dist",
]);
/** Keywords that legitimately sit right before a "(" — IN (…), OVER (…), a CTE's AS (…). */
const KEYWORDS_BEFORE_PAREN = new Set([
  "in", "exists", "as", "over", "filter", "within", "values", "using", "on", "and", "or", "not",
  "when", "then", "else", "case", "select", "from", "join", "where", "having", "by", "all", "any",
  "some", "distinct", "union", "intersect", "except", "with", "is", "between", "like", "end",
]);
/** Type names that take a "(" inside CAST — DECIMAL(10,2), VARCHAR(20). */
const SQL_TYPE_NAMES = new Set([
  "decimal", "numeric", "varchar", "char", "integer", "int", "bigint", "real", "float", "double",
  "text", "boolean", "timestamp",
]);
/** Functions whose own arguments use FROM — EXTRACT(YEAR FROM d), SUBSTRING(s FROM 2). */
const FROM_INSIDE_FUNCTIONS = new Set(["extract", "substring", "trim", "position", "overlay"]);
/** Words that end a FROM clause's table list. */
const FROM_LIST_ENDS = new Set([
  "where", "group", "order", "having", "limit", "offset", "union", "intersect", "except",
  "window", "qualify", "select", "fetch",
]);
const MAX_COMPOSED_SQL_LENGTH = 6000;

type SqlToken = { kind: "word" | "quoted" | "string" | "number" | "punct" | "op"; value: string };

function composedSqlError(detail: string): Error {
  return new Error(`SQL validation failed: ${detail}`);
}

/** Just enough of a lexer to tell identifiers, quoted names, string
 *  literals and punctuation apart — so a keyword inside a string can't
 *  hide from the checks and a quoted path can't pose as a name. */
function tokenizeSql(sql: string, opts: { lenientQuotes?: boolean } = {}): SqlToken[] {
  const out: SqlToken[] = [];
  const n = sql.length;
  let i = 0;
  const readQuoted = (quote: string): string => {
    let j = i + 1;
    let v = "";
    for (;;) {
      if (j >= n) throw composedSqlError("unterminated quote");
      if (sql[j] === quote) {
        if (sql[j + 1] === quote) { v += quote; j += 2; continue; }
        break;
      }
      v += sql[j++];
    }
    i = j + 1;
    return v;
  };
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "-" && sql[i + 1] === "-") { while (i < n && sql[i] !== "\n") i++; continue; }
    if (c === "/" && sql[i + 1] === "*") { const end = sql.indexOf("*/", i + 2); i = end === -1 ? n : end + 2; continue; }
    if (c === "'") { out.push({ kind: "string", value: readQuoted("'") }); continue; }
    if (c === "\"") { out.push({ kind: "quoted", value: readQuoted("\"").toLowerCase() }); continue; }
    if (c === "`" || c === "[") {
      // The AI-SQL path forbids these outright. The human lake-SQL path
      // (assertNoLakeFileAccess, lenientQuotes) tolerates them as ordinary
      // punctuation instead: DuckDB uses [] for list/struct indexing
      // (`col[1]`, `struct['k']`) and rejects backticks at parse time, so
      // neither can smuggle a hidden relation or function call past the
      // relation/function checks below — and rejecting a legitimate `col[1]`
      // outright would be a false positive on real report SQL.
      if (opts.lenientQuotes) { out.push({ kind: "op", value: c }); i++; continue; }
      throw composedSqlError("quote identifiers with double quotes");
    }
    if (/[\p{L}_]/u.test(c)) {
      let j = i + 1;
      while (j < n && /[\p{L}\p{M}\p{N}_$]/u.test(sql[j])) j++;
      out.push({ kind: "word", value: sql.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9.eE]/.test(sql[j])) j++;
      out.push({ kind: "number", value: sql.slice(i, j) });
      i = j;
      continue;
    }
    if ("(),.;".includes(c)) { out.push({ kind: "punct", value: c }); i++; continue; }
    out.push({ kind: "op", value: c });
    i++;
  }
  return out;
}

const isPunct = (t: SqlToken | undefined, v: string) => t?.kind === "punct" && t.value === v;
const isWord = (t: SqlToken | undefined, v: string) => t?.kind === "word" && t.value === v;

/**
 * Stricter check for SQL a model wrote rather than a person — the derived
 * datasets Auto-Curf's prompt composer lets the model add to join tables
 * or compute a flag. assertSelectOnly stops writes; this also stops reads
 * outside the report's own tables:
 *
 *  - every FROM / JOIN target, comma joins included, is one of
 *    `allowedTables` or a CTE the query defines itself — no other table,
 *    no schema-qualified name, no string literal (DuckDB reads a quoted
 *    path as a file), no table function;
 *  - every function call is on a short allowlist of pure functions, so
 *    read_csv / read_text / glob / getenv / load_extension / pragma_* and
 *    the like can't be called anywhere in it.
 *
 * The request the model answered is tenant-written text, so its SQL is
 * untrusted input. This is the enforcement; the prompt's rules are only
 * guidance. Deliberately conservative: a query it can't vouch for is
 * refused, not repaired.
 */
export function assertComposedSqlSafe(sql: string, allowedTables: string[]): void {
  assertSelectOnly(sql);
  if (sql.length > MAX_COMPOSED_SQL_LENGTH) throw composedSqlError("query is too long");
  const toks = tokenizeSql(sql);
  if (toks.some((t) => isWord(t, "recursive"))) throw composedSqlError("recursive queries are not allowed");

  // Names the query defines for itself: `name AS (`.
  const ctes = new Set<string>();
  toks.forEach((t, k) => {
    if ((t.kind === "word" || t.kind === "quoted") && isWord(toks[k + 1], "as") && isPunct(toks[k + 2], "(")) ctes.add(t.value);
  });
  const allowed = new Set(allowedTables.map((t) => t.toLowerCase()));

  // Every call is to an allowlisted function.
  toks.forEach((t, k) => {
    if (!isPunct(toks[k + 1], "(")) return;
    if (t.kind === "quoted") throw composedSqlError("quoted function names are not allowed");
    if (t.kind !== "word") return;
    if (isPunct(toks[k - 1], ".")) throw composedSqlError(`"${t.value}(" — qualified function calls are not allowed`);
    if (KEYWORDS_BEFORE_PAREN.has(t.value) || COMPOSED_SQL_FUNCTIONS.has(t.value) || SQL_TYPE_NAMES.has(t.value)) return;
    throw composedSqlError(`function "${t.value}" is not allowed here`);
  });

  // Every relation read is one of this report's tables.
  const checkRelation = (j: number) => {
    const r = toks[j];
    if (isPunct(r, "(")) {
      // A subquery is walked (and checked) like the rest; a parenthesised
      // join list is refused rather than parsed.
      if (!isWord(toks[j + 1], "select") && !isWord(toks[j + 1], "with")) {
        throw composedSqlError("parenthesised joins are not allowed");
      }
      return;
    }
    if (r && (r.kind === "word" || r.kind === "quoted")) {
      if (isPunct(toks[j + 1], ".")) throw composedSqlError(`"${r.value}." — schema-qualified tables are not allowed`);
      if (isPunct(toks[j + 1], "(")) throw composedSqlError(`"${r.value}(" — table functions are not allowed`);
      if (!allowed.has(r.value) && !ctes.has(r.value)) {
        throw composedSqlError(`table "${r.value}" is not one of this report's tables`);
      }
      return;
    }
    throw composedSqlError("only this report's tables can be read");
  };

  const stack: Array<{ opener: string | null; fromList: boolean }> = [{ opener: null, fromList: false }];
  toks.forEach((t, k) => {
    if (isPunct(t, "(")) {
      const prev = toks[k - 1];
      stack.push({ opener: prev?.kind === "word" ? prev.value : null, fromList: false });
      return;
    }
    if (isPunct(t, ")")) {
      if (stack.length === 1) throw composedSqlError("unbalanced parentheses");
      stack.pop();
      return;
    }
    const top = stack[stack.length - 1];
    if (isWord(t, "from") || isWord(t, "join")) {
      if (t.value === "from" && top.opener && FROM_INSIDE_FUNCTIONS.has(top.opener)) return;
      if (t.value === "from" && isWord(toks[k - 1], "distinct")) return; // IS [NOT] DISTINCT FROM
      checkRelation(k + 1);
      top.fromList = true;
      return;
    }
    if (t.kind === "word" && FROM_LIST_ENDS.has(t.value)) { top.fromList = false; return; }
    if (isPunct(t, ",") && top.fromList) checkRelation(k + 1);
  });
  if (stack.length !== 1) throw composedSqlError("unbalanced parentheses");
}

// ---------------------------------------------------------------------------
// Human-authored SQL that runs against a tenant's lake
// ---------------------------------------------------------------------------

/**
 * DuckDB table/scalar functions that read the local filesystem, reach the
 * network, load extensions, or expose the server's own config/secrets.
 *
 * Only the DuckDB lake engine (Team+ tier) has these — SQLite (better-
 * sqlite3, the default engine for every tenant today) has no such
 * functions, so a query it can't parse just errors. But a DuckDB-engine
 * tenant's editor could otherwise run `SELECT * FROM read_csv('/etc/hostname')`
 * or `read_parquet('/data/lake/<other-tenant>/…')` and read another tenant's
 * lake files under the shared CURF_LAKE_DIR, or the app's own files/env.
 *
 * The families below are matched by prefix so a DuckDB point release adding
 * `read_arrow`, another `sqlite_*`, etc. is denied without a code change:
 *   read_*      read_csv[_auto] / read_parquet / read_json / read_text /
 *               read_blob / read_ndjson* / read_duckdb …  (every reader)
 *   sqlite_*    sqlite_scan / sqlite_query / sqlite_attach
 *   iceberg_*   delta_*   arrow_*                        (lakehouse readers)
 *   parquet_*   parquet_scan + the *_metadata introspectors
 *   duckdb_*    duckdb_settings / duckdb_secrets / …     (catalog/secret introspection)
 *   pragma_*    pragma_table_info / pragma_database_size …
 * plus the exact names below (no shared prefix). `json_*` is deliberately
 * NOT prefix-denied — json_extract/json_value etc. are pure and common; only
 * the three SQL-from-JSON executors are named out explicitly.
 */
const LAKE_FORBIDDEN_FN_PREFIX =
  /^(read_|sqlite_|iceberg_|delta_|arrow_|parquet_|duckdb_|pragma_)/;
const LAKE_FORBIDDEN_FN_EXACT = new Set([
  "glob", "query", "query_table", "sniff_csv",
  "copy_database", "import_database",
  "current_setting", "set_config", "getvariable", "getenv",
  "current_query", "current_query_id", "which_secret", "write_log",
  "install", "load", "attach", "detach",
  "enable_logging", "disable_logging", "checkpoint", "force_checkpoint",
  "json_execute_serialized_sql", "json_serialize_sql", "json_deserialize_sql",
]);

function isForbiddenLakeFn(name: string): boolean {
  return LAKE_FORBIDDEN_FN_EXACT.has(name) || LAKE_FORBIDDEN_FN_PREFIX.test(name);
}

/** A double-quoted identifier whose text is really a filesystem path or a
 *  URL — DuckDB's replacement scan turns `FROM "C:/x.duckdb"` or
 *  `FROM "/data/lake/…"` into a file read just like a single-quoted one. A
 *  real lake table/view name is `[a-z0-9_]` (see toSafeTableName), so none
 *  of these ever appear in a legitimate one. */
function looksLikePath(v: string): boolean {
  return /[\\/]/.test(v) || /^[a-z]:/i.test(v) || /:\/\//.test(v);
}

/**
 * Reject a lake query that reads a file, reaches the network, or reads a
 * tenant's data through anything other than a plain table/view/CTE name.
 * This is the enforcement behind the "your report SQL is read-only against
 * your own tables" promise for a DuckDB-engine tenant — assertSelectOnly
 * already blocks writes/DDL/ATTACH/PRAGMA, but NOT DuckDB's file/table
 * functions or a quoted path posing as a table.
 *
 * Deliberately a deny-list, not assertComposedSqlSafe's pure-function
 * allow-list: people writing report / notebook / DQ SQL by hand legitimately
 * reach for arbitrary scalar, date and window functions we don't want to
 * enumerate, so we name the dangerous readers instead and let everything
 * else through.
 *
 * Does NOT require the statement to be a SELECT (assertLakeReadSqlSafe layers
 * that on for the user-facing surfaces) — it's also the last-line backstop at
 * the DuckDB execution point (ee.lake.readLakeIfPaidEngine), which also runs
 * platform-issued SQL like `PRAGMA table_info("t")` that must still pass.
 *
 * External tables and materialized views are safe under this rule: they're
 * exposed to user SQL as ordinary DuckDB *views* (`CREATE OR REPLACE VIEW …
 * AS SELECT * FROM read_parquet('s3://…')`), so the query a person writes is
 * `SELECT … FROM my_external_table` — no read_parquet in the text they
 * authored — and DuckDB expands the view internally when it runs. The
 * platform SQL that builds those views (lib/lake/external.ts,
 * materializeParquet.ts) never passes through this guard.
 */
export function assertNoLakeFileAccess(sql: string): void {
  const toks = tokenizeSql(sql, { lenientQuotes: true });

  // (1) No forbidden reader called anywhere — projection, WHERE, or FROM.
  //     A schema/catalog-qualified call (`system.main.read_csv(…)`) still
  //     resolves to the bare function name that sits right before the "(".
  toks.forEach((t, k) => {
    if (!isPunct(toks[k + 1], "(")) return;
    if (t.kind !== "word" && t.kind !== "quoted") return;
    if (isForbiddenLakeFn(t.value)) {
      throw composedSqlError(`function "${t.value}(…)" is not allowed in lake SQL`);
    }
  });

  // (2) Every relation must be a plain name — never a file path or table
  //     function. DuckDB reads a quoted path as a table via its replacement
  //     scan, so `FROM '/x.csv'`, `FROM "C:/other.duckdb"` and
  //     `FROM read_csv('…')` all have to be refused in a FROM / JOIN /
  //     comma-join / PIVOT / UNPIVOT / DESCRIBE / SUMMARIZE position.
  const checkRelation = (j: number) => {
    const r = toks[j];
    if (!r) return;
    if (r.kind === "string") {
      throw composedSqlError("a string literal can't be used as a table (file paths are not allowed)");
    }
    if (isPunct(r, "(")) return; // subquery / parenthesised source — its own tokens are walked by the loop
    if (r.kind === "word" || r.kind === "quoted") {
      if (isPunct(toks[j + 1], "(")) {
        throw composedSqlError(`"${r.value}(…)" — table functions are not allowed in lake SQL`);
      }
      if (r.kind === "quoted" && looksLikePath(r.value)) {
        throw composedSqlError("a quoted file path can't be used as a table");
      }
    }
  };

  const RELATION_INTRODUCERS = new Set(["from", "join", "pivot", "unpivot", "describe", "summarize"]);
  const stack: Array<{ opener: string | null; fromList: boolean }> = [{ opener: null, fromList: false }];
  toks.forEach((t, k) => {
    if (isPunct(t, "(")) {
      const prev = toks[k - 1];
      stack.push({ opener: prev?.kind === "word" ? prev.value : null, fromList: false });
      return;
    }
    if (isPunct(t, ")")) { if (stack.length > 1) stack.pop(); return; }
    const top = stack[stack.length - 1];
    if (t.kind === "word" && RELATION_INTRODUCERS.has(t.value)) {
      // FROM as a function argument, not a clause: EXTRACT(YEAR FROM d),
      // SUBSTRING(s FROM 2), TRIM(… FROM …), and `x IS [NOT] DISTINCT FROM y`.
      if (t.value === "from" && top.opener && FROM_INSIDE_FUNCTIONS.has(top.opener)) return;
      if (t.value === "from" && isWord(toks[k - 1], "distinct")) return;
      checkRelation(k + 1);
      top.fromList = t.value === "from" || t.value === "join";
      return;
    }
    if (t.kind === "word" && FROM_LIST_ENDS.has(t.value)) { top.fromList = false; return; }
    if (isPunct(t, ",") && top.fromList) checkRelation(k + 1);
  });
}

/**
 * The full guard for a lake query a *person* authored — report Designer
 * queries, Notebook SQL cells, Data Quality custom_sql, the Agent's
 * query_lake tool, Activation SQL sources. SELECT-only (assertSelectOnly)
 * plus no file/network access (assertNoLakeFileAccess). Use this at the
 * surface that accepts the SQL; ee.lake.readLakeIfPaidEngine additionally
 * re-runs assertNoLakeFileAccess at execution time as a backstop.
 */
export function assertLakeReadSqlSafe(sql: string): void {
  assertSelectOnly(sql);
  assertNoLakeFileAccess(sql);
}
