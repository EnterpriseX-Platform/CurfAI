/**
 * distinctColumnValues — the FK-resolution counterpart to synthetic.ts's
 * fkKeyValues() for a parent table Master Builder did NOT generate this
 * run (an existing tenant table a plan references via source:"existing").
 *
 * The live failure this closes: a custom plan's fk:retail_stores fell back
 * to a count-only reconstruction (retail_stores was skipped, never
 * generateRows'd, so there were no in-memory rows to read real keys from)
 * and produced "store_0010" against a real table keyed "S-101" — a
 * dangling join from the first row. This reads the parent's ACTUAL key
 * values straight out of the lake instead.
 *
 * openLake is mocked to a real in-memory better-sqlite3 handle — same
 * "run the real quoting against a real engine" spirit as identifier.test.ts
 * — so these prove the function against real SQL, not a stubbed return.
 */
import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";

let db: InstanceType<typeof Database>;

vi.mock("./storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./storage")>();
  return { ...actual, openLake: () => db };
});

import { distinctColumnValues, qIdent } from "./tables";

function freshDb() {
  db = new Database(":memory:");
}

describe("distinctColumnValues", () => {
  it("reads real, code-keyed values — not a makeId()-style reconstruction", () => {
    freshDb();
    db.exec(`CREATE TABLE "retail_stores" (${qIdent("store_code")} TEXT, ${qIdent("store_name")} TEXT)`);
    const ins = db.prepare(`INSERT INTO "retail_stores" VALUES (?, ?)`);
    ins.run("S-101", "Riverside Store");
    ins.run("S-102", "Northgate Store");
    ins.run("S-103", "Harbour Store");

    const keys = distinctColumnValues("t1", "retail_stores", "store_code");
    expect(keys.sort()).toEqual(["S-101", "S-102", "S-103"]);
  });

  it("drops NULL and empty-string values — never a usable FK target", () => {
    freshDb();
    db.exec(`CREATE TABLE "t" (${qIdent("code")} TEXT)`);
    const ins = db.prepare(`INSERT INTO "t" VALUES (?)`);
    ins.run("A");
    ins.run(null);
    ins.run("");
    ins.run("B");

    expect(distinctColumnValues("t1", "t", "code").sort()).toEqual(["A", "B"]);
  });

  it("de-duplicates — DISTINCT, not every row", () => {
    freshDb();
    db.exec(`CREATE TABLE "t" (${qIdent("code")} TEXT)`);
    const ins = db.prepare(`INSERT INTO "t" VALUES (?)`);
    ins.run("A"); ins.run("A"); ins.run("A"); ins.run("B");

    expect(distinctColumnValues("t1", "t", "code").sort()).toEqual(["A", "B"]);
  });

  it("caps the result rather than returning an unbounded list", () => {
    freshDb();
    db.exec(`CREATE TABLE "t" (${qIdent("code")} TEXT)`);
    const ins = db.prepare(`INSERT INTO "t" VALUES (?)`);
    for (let i = 0; i < 50; i++) ins.run(`v${i}`);

    expect(distinctColumnValues("t1", "t", "code", 10)).toHaveLength(10);
  });

  it("degrades to an empty array rather than throwing when the table doesn't exist", () => {
    freshDb();
    expect(distinctColumnValues("t1", "no_such_table", "code")).toEqual([]);
  });

  it("degrades to an empty array rather than throwing when the column doesn't exist", () => {
    freshDb();
    db.exec(`CREATE TABLE "t" (${qIdent("other_col")} TEXT)`);
    expect(distinctColumnValues("t1", "t", "code")).toEqual([]);
  });

  it("a column name that looks like it could break out of the quoting is safely escaped", () => {
    freshDb();
    // Same attack shape identifier.test.ts proves against qIdent directly —
    // this checks the FULL function doesn't reintroduce it via string
    // interpolation elsewhere in the query.
    const evil = 'code" ; DROP TABLE t; --';
    db.exec(`CREATE TABLE "t" (${qIdent(evil)} TEXT)`);
    db.prepare(`INSERT INTO "t" (${qIdent(evil)}) VALUES (?)`).run("v");
    expect(distinctColumnValues("t1", "t", evil)).toEqual(["v"]);
    // The table is still there — no injected DROP TABLE ran.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM "t"`).get()).toEqual({ n: 1 });
  });
});
