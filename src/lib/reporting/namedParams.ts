/**
 * `:name` placeholder rewriting shared by every SQL driver — the Community
 * ones in runner.ts and the paid warehouse drivers in src/ee/connectors.
 * Lives in its own module so a driver never has to import the runner.
 */
// The regex avoids matching `::` (Postgres cast operator) by requiring a
// non-colon prefix and a non-colon next char.
const NAMED_PARAM_RE = /(^|[^:]):([a-zA-Z_][a-zA-Z0-9_]*)\b(?!:)/g;

export function rewriteNamedParams(
  sql: string,
  params: Record<string, unknown>,
  emit: (name: string) => string,
): { sql: string; missing: string[] } {
  const missing: string[] = [];
  const rewritten = sql.replace(NAMED_PARAM_RE, (m, lead, name) => {
    if (!(name in params)) {
      if (!missing.includes(name)) missing.push(name);
      return m; // leave it alone - the driver will throw a clearer error
    }
    return lead + emit(name);
  });
  return { sql: rewritten, missing };
}

/**
 * Translate SQLite-style `:name` placeholders into MySQL's positional `?`
 * binds. Each occurrence of `:name` becomes a `?` and the value is appended
 * to the values array IN ORDER (mysql2 doesn't accept named binds without
 * the `namedPlaceholders` flag, and even with that flag mixed value/named
 * usage gets fiddly — positional is the safer default).
 *
 * Skips `::name` (no Postgres-style cast operator on MySQL but we keep the
 * regex consistent with translateNamedToPositional for safety).
 */
export function translateNamedToQuestionMark(
  sql: string,
  params: Record<string, unknown>,
): { sql: string; values: unknown[]; missing: string[] } {
  const values: unknown[] = [];
  const { sql: rewritten, missing } = rewriteNamedParams(sql, params, (name) => {
    values.push(params[name]);
    return "?";
  });
  return { sql: rewritten, values, missing };
}
