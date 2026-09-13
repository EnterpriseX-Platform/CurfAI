/**
 * Cross-database raw SQL placeholders.
 *
 * Write raw SQL with SQLite/MySQL-style `?` placeholders, then pass it
 * through this before calling $executeRawUnsafe/$queryRawUnsafe. Prisma
 * passes placeholders straight through to the underlying driver — it does
 * not translate between dialects — and Postgres only understands
 * positional $1, $2, ...; a literal `?` against Postgres fails with a
 * syntax error at the `?`. This makes the same call site work whichever
 * provider prisma/schema.prisma + DATABASE_URL currently point at (see
 * CLAUDE.md: SQLite for dev, Postgres for prod, switched via DATABASE_URL).
 *
 * No Prisma import here on purpose — this is pure string handling, kept
 * dependency-free so it's testable without pulling in the Prisma client.
 */
function isPostgres(): boolean {
  return /^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL ?? "");
}

export function toDriverSql(sql: string): string {
  if (!isPostgres()) return sql;
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}
