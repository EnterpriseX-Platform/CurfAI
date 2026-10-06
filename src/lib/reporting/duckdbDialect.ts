/**
 * What to tell an LLM that writes SQL for a lake running on DuckDB.
 *
 * The prompts used to say "SQLite" for every lake source, so a migrated tenant
 * got `strftime('%Y-%m', col)` and `date('now')` — neither of which runs on
 * DuckDB. Every claim below was checked against a real DuckDB file with the
 * lake's TEXT columns; lib/lake/engine/duckdbDialect.test.ts re-runs them, so
 * this can't drift into folklore.
 */
export const DUCKDB_LAKE_DIALECT_GUIDANCE: string[] = [
  "- This is DUCKDB (the workspace's lake). DO NOT use SQLite-only built-ins: date('now'), date(col, '-7 days'), datetime('now'), julianday(), or strftime('%Y-%m', col) (SQLite's argument order) — they fail on DuckDB.",
  "- Every lake column is TEXT unless it was converted: CAST before date math or arithmetic.",
  "- Date bucketing: strftime(CAST(col AS TIMESTAMP), '%Y-%m') for month and strftime(CAST(col AS TIMESTAMP), '%Y-W%W') for week — the timestamp goes FIRST and the format second, the reverse of SQLite. date_trunc('month', CAST(col AS TIMESTAMP)) also works; for a plain month key on ISO text, substr(col, 1, 7).",
  "- Current time: current_date / now(). Date math: CAST(col AS DATE) - INTERVAL 7 DAY.",
  "- Numbers stored as text: SUM(TRY_CAST(col AS DOUBLE)). CAST(col AS DOUBLE) raises an error on any non-numeric cell (SQLite would give 0) and fails the whole query.",
  "- String concat: col1 || col2. Prefer COALESCE over IFNULL.",
];

/** One line for prompts that don't have a full dialect section. */
export const DUCKDB_LAKE_DIALECT_ONE_LINER =
  "DuckDB dialect, NOT SQLite: no date('now'), datetime() or julianday(); strftime takes the timestamp first " +
  "(strftime(CAST(col AS TIMESTAMP), '%Y-%m')); columns are TEXT, so CAST before date math or arithmetic " +
  "(TRY_CAST(col AS DOUBLE) for numbers)";
