/**
 * assertSelectOnly is the single DDL/DML guard shared by every SQL driver
 * in the runner (sqlite, postgres, mysql, snowflake, bigquery) — it's the
 * last line of defense between a report author's saved SQL and a live
 * connection with real credentials. It had zero test coverage despite being
 * arguably the most security-critical function in the reporting stack;
 * these tests pin its accept/reject behavior so a future edit (a new
 * dialect, a regex tweak) can't silently widen what gets through.
 */
import { describe, it, expect } from "vitest";
import { assertSelectOnly, assertRestMethodAllowed } from "./runner";

describe("assertSelectOnly — accepts read-only queries", () => {
  it("accepts a plain SELECT", () => {
    expect(() => assertSelectOnly("SELECT id, name FROM users")).not.toThrow();
  });

  it("accepts SELECT in any case", () => {
    expect(() => assertSelectOnly("select id from users")).not.toThrow();
    expect(() => assertSelectOnly("SeLeCt id FROM users")).not.toThrow();
  });

  it("accepts a WITH (CTE) query", () => {
    expect(() =>
      assertSelectOnly("WITH recent AS (SELECT id FROM users WHERE created_at > :since) SELECT * FROM recent"),
    ).not.toThrow();
  });

  it("accepts leading whitespace/newlines before SELECT", () => {
    expect(() => assertSelectOnly("\n\n  SELECT 1")).not.toThrow();
  });

  it("accepts a single trailing semicolon", () => {
    expect(() => assertSelectOnly("SELECT id FROM users;")).not.toThrow();
    expect(() => assertSelectOnly("SELECT id FROM users;   ")).not.toThrow();
  });

  it("strips line comments before validating", () => {
    expect(() => assertSelectOnly("SELECT id FROM t -- delete everything later\n")).not.toThrow();
  });

  it("strips block comments before validating", () => {
    expect(() => assertSelectOnly("SELECT id FROM t /* insert a note here */ WHERE id = :id")).not.toThrow();
  });

  it("does not false-positive on identifiers that contain forbidden words as substrings", () => {
    // \b word-boundary means "create" inside "createdAt" must NOT match —
    // these are extremely common column names and a false rejection here
    // would break most real reports.
    expect(() => assertSelectOnly("SELECT createdAt, updatedAt, deletedAt FROM users")).not.toThrow();
    expect(() => assertSelectOnly("SELECT id FROM insertions")).not.toThrow();
    expect(() => assertSelectOnly("SELECT id FROM updates_log")).not.toThrow();
  });
});

describe("assertSelectOnly — rejects everything else", () => {
  it("rejects an empty query", () => {
    expect(() => assertSelectOnly("")).toThrow(/empty query/);
    expect(() => assertSelectOnly("   \n  ")).toThrow(/empty query/);
  });

  it("rejects a query that doesn't start with SELECT or WITH", () => {
    expect(() => assertSelectOnly("EXPLAIN SELECT 1")).toThrow(/only SELECT/);
  });

  it.each([
    "INSERT INTO users (name) VALUES ('x')",
    "UPDATE users SET name = 'x'",
    "DELETE FROM users",
    "DROP TABLE users",
    "ALTER TABLE users ADD COLUMN x TEXT",
    "CREATE TABLE evil (id INT)",
    "REPLACE INTO users (id) VALUES (1)",
    "TRUNCATE TABLE users",
    "ATTACH DATABASE '/etc/passwd' AS x",
    "DETACH DATABASE x",
    "PRAGMA table_info(users)",
    "VACUUM",
    "REINDEX",
    "EXEC sp_who",
    "EXECUTE some_proc()",
    "MERGE INTO users USING staging ON users.id = staging.id",
    "GRANT ALL ON users TO public",
    "REVOKE ALL ON users FROM public",
    // MySQL arbitrary file write and Postgres smuggled table creation — both
    // start with a bare SELECT, so only the FORBIDDEN keyword list (not the
    // "must start with SELECT/WITH" gate) catches these.
    "SELECT * FROM t INTO OUTFILE '/var/www/html/shell.php'",
    "SELECT * FROM t INTO DUMPFILE '/tmp/x'",
    "SELECT * INTO new_table FROM t",
  ])("rejects top-level %s", (sql) => {
    // Most of these also fail the earlier "must start with SELECT/WITH"
    // gate, so the exact message varies — what matters is that every one
    // of them is rejected.
    expect(() => assertSelectOnly(sql)).toThrow();
  });

  it("rejects a forbidden statement smuggled after a leading SELECT via a semicolon", () => {
    expect(() => assertSelectOnly("SELECT 1; DROP TABLE users")).toThrow();
  });

  it("rejects multiple statements even when both are SELECTs", () => {
    expect(() => assertSelectOnly("SELECT 1; SELECT 2")).toThrow(/multiple statements/);
  });

  it("rejects a DDL keyword regardless of case", () => {
    expect(() => assertSelectOnly("select id from users; Drop Table users")).toThrow();
  });

  it("rejects a forbidden keyword hidden inside a CTE body", () => {
    expect(() =>
      assertSelectOnly("WITH x AS (DELETE FROM users RETURNING id) SELECT * FROM x"),
    ).toThrow(/write or DDL statements are not allowed/);
  });

  it("rejects a forbidden keyword directly after punctuation with no space (writable-CTE smuggle)", () => {
    // Postgres/SQLite support writable CTEs — "(DELETE ..." with zero
    // whitespace after the paren is valid SQL syntax, not a typo.
    expect(() => assertSelectOnly("WITH x AS(DELETE FROM users RETURNING id) SELECT * FROM x")).toThrow();
    expect(() => assertSelectOnly("SELECT(DROP TABLE users)")).toThrow();
  });
});

// REST's counterpart to assertSelectOnly — SQL-kind sources are always
// SELECT-only regardless of any flag, but REST has no such built-in
// restriction, so DataSource.readOnly is the only thing that can block a
// write against a REST connection.
describe("assertRestMethodAllowed", () => {
  it("allows GET regardless of the readOnly flag", () => {
    expect(() => assertRestMethodAllowed("GET", true)).not.toThrow();
    expect(() => assertRestMethodAllowed("GET", false)).not.toThrow();
    expect(() => assertRestMethodAllowed("GET", null)).not.toThrow();
    expect(() => assertRestMethodAllowed("GET", undefined)).not.toThrow();
  });

  it("allows any method when readOnly is falsy", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(() => assertRestMethodAllowed(m, false)).not.toThrow();
      expect(() => assertRestMethodAllowed(m, null)).not.toThrow();
      expect(() => assertRestMethodAllowed(m, undefined)).not.toThrow();
    }
  });

  it("rejects a non-GET method when readOnly is true", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(() => assertRestMethodAllowed(m, true)).toThrow(/read-only/);
    }
  });

  it("is case-insensitive on the method", () => {
    expect(() => assertRestMethodAllowed("get", true)).not.toThrow();
    expect(() => assertRestMethodAllowed("post", true)).toThrow(/read-only/);
  });
});
