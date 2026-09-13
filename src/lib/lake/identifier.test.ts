/**
 * Column names in the lake bulk-ingest paths come from untrusted upload /
 * webhook / CDC payload keys. They used to be spliced into DDL/DML as
 * `"${name}"` with no escaping, so a key like `x" TEXT UNIQUE, "y` broke out
 * of the identifier and injected a constraint / extra column. qIdent doubles
 * embedded quotes; these tests prove the break-out no longer happens by
 * running the exact quoting against a real SQLite engine.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { qIdent } from "./tables";

describe("qIdent — SQLite identifier escaping", () => {
  it("doubles embedded double-quotes", () => {
    expect(qIdent("amount")).toBe('"amount"');
    expect(qIdent('x" , "y')).toBe('"x"" , ""y"');
  });

  it("a malicious column name creates ONE column, not injected DDL", () => {
    const db = new Database(":memory:");
    const evil = 'x" TEXT UNIQUE, "y';
    // This is exactly how createOrReplaceTable builds the DDL.
    db.exec(`CREATE TABLE "t" (${qIdent(evil)} TEXT)`);
    const cols = (db.prepare(`PRAGMA table_info("t")`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual([evil]);          // one column, literally named the evil string
    expect(cols).toHaveLength(1);          // NOT ["x", "y"]
    db.close();
  });

  it("preserves legitimate names with spaces and hyphens", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE "t" (${qIdent("Order ID")} TEXT, ${qIdent("full-name")} TEXT)`);
    const cols = (db.prepare(`PRAGMA table_info("t")`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(["Order ID", "full-name"]);
    db.close();
  });

  it("insert/select round-trips a quote-bearing column name", () => {
    const db = new Database(":memory:");
    const col = 'na"me';
    db.exec(`CREATE TABLE "t" (${qIdent(col)} TEXT)`);
    db.prepare(`INSERT INTO "t" (${qIdent(col)}) VALUES (?)`).run("v");
    const row = db.prepare(`SELECT ${qIdent(col)} AS x FROM "t"`).get() as any;
    expect(row.x).toBe("v");
    db.close();
  });
});
