/**
 * Regression: src/lib/operate/why.ts silently failed to persist the "why
 * this matters" digest on every single Operate request, on Postgres,
 * because its raw SQL used `?` placeholders — valid for SQLite, a syntax
 * error for Postgres, which needs positional $1, $2, ... This covers the
 * shared fix so any other raw-SQL call site that adopts toDriverSql() gets
 * the same cross-database behavior verified once, here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { toDriverSql } from "./sqlPlaceholders";

describe("toDriverSql", () => {
  const original = process.env.DATABASE_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  });

  it("leaves ? placeholders untouched for SQLite", () => {
    process.env.DATABASE_URL = "file:./dev.db";
    expect(toDriverSql(`UPDATE "T" SET "a" = ? WHERE "id" = ?`)).toBe(`UPDATE "T" SET "a" = ? WHERE "id" = ?`);
  });

  it("converts ? to positional $1, $2, ... in order for Postgres", () => {
    process.env.DATABASE_URL = "postgresql://curf:curf@localhost:5432/curf";
    expect(toDriverSql(`UPDATE "T" SET "a" = ? WHERE "id" = ?`)).toBe(`UPDATE "T" SET "a" = $1 WHERE "id" = $2`);
  });

  it("also recognizes the postgres:// scheme (without the ql)", () => {
    process.env.DATABASE_URL = "postgres://curf:curf@localhost:5432/curf";
    expect(toDriverSql(`SELECT * FROM "T" WHERE "x" = ?`)).toBe(`SELECT * FROM "T" WHERE "x" = $1`);
  });

  it("is a no-op on SQL with no placeholders", () => {
    process.env.DATABASE_URL = "postgresql://curf:curf@localhost:5432/curf";
    expect(toDriverSql(`DELETE FROM "T"`)).toBe(`DELETE FROM "T"`);
  });

  it("numbers many placeholders sequentially, not just the first two", () => {
    process.env.DATABASE_URL = "postgresql://curf:curf@localhost:5432/curf";
    expect(toDriverSql(`INSERT INTO "T" ("a","b","c") VALUES (?, ?, ?)`)).toBe(
      `INSERT INTO "T" ("a","b","c") VALUES ($1, $2, $3)`,
    );
  });
});
