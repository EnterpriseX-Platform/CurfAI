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
export function assertSelectOnly(sql: string) {
  // Strip line + block comments and leading whitespace.
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
  if (!stripped) throw new Error("SQL validation failed: empty query");

  // Must begin with SELECT or WITH (CTE).
  if (!/^(select|with)\b/i.test(stripped)) {
    throw new Error("SQL validation failed: only SELECT (or WITH ... SELECT) statements are allowed");
  }

  // Reject any top-level write/DDL/side-effect keyword. Word-boundaries on
  // both sides avoid false positives on identifier substrings like
  // "createdAt" while still catching the keyword directly after punctuation
  // with no space — e.g. a Postgres writable-CTE smuggle attempt like
  // "WITH x AS (DELETE FROM t RETURNING id) SELECT * FROM x" has no
  // whitespace before DELETE, which a whitespace-only leading anchor would
  // miss entirely.
  const FORBIDDEN = [
    "insert", "update", "delete", "drop", "alter", "create", "replace",
    "truncate", "attach", "detach", "pragma", "vacuum", "reindex",
    "exec", "execute", "merge", "grant", "revoke",
    // "into" catches MySQL's SELECT...INTO OUTFILE/DUMPFILE (arbitrary file
    // write) and Postgres's SELECT...INTO new_table (smuggled DDL) — neither
    // is legitimate in a read-only report query.
    "into",
  ];
  const re = new RegExp(`\\b(?:${FORBIDDEN.join("|")})\\b`, "i");
  if (re.test(stripped)) {
    throw new Error("SQL validation failed: write or DDL statements are not allowed");
  }

  // Reject explicit multi-statement queries via top-level semicolon. Trailing
  // semicolons after the final statement are fine; only flag if anything
  // non-comment follows.
  const semi = stripped.indexOf(";");
  if (semi !== -1 && stripped.slice(semi + 1).trim().length > 0) {
    throw new Error("SQL validation failed: multiple statements are not allowed");
  }
}
