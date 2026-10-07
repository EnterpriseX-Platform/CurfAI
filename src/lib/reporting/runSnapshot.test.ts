import { describe, expect, it } from "vitest";
import { ENGINE_NOT_STORED_NOTE, SNAPSHOT_MAX_CHARS, isEngineDerived, redactEngineProvenance, snapshotOf, withoutEngineRows } from "./runSnapshot";

const prov = (over: object = {}) => ({
  queryId: "q", queryName: "Q", queryHash: "sha256:aaa", runAt: "2026-01-01T00:00:00Z", durationMs: 5, rowCount: 3,
  dataHash: "sha256:bbb", dataSourceName: "Src", dataSourceKind: "postgres", ...over,
}) as any;

const rows = [{ id: 1, email: "a@x.test" }, { id: 2, email: "b@x.test" }];

describe("isEngineDerived", () => {
  it("is true for the engine's own queries and for a query that joined or attached one", () => {
    expect(isEngineDerived(prov({ dataSourceKind: "engine" }))).toBe(true);
    expect(isEngineDerived(prov({ attachedSources: [{ name: "E", kind: "engine", alias: "e" }] }))).toBe(true);
    expect(isEngineDerived(prov({ attachedSources: [{ name: "X", kind: "excel", alias: "x" }, { name: "E", kind: "engine", alias: "e" }] }))).toBe(true);
  });
  it("is false for everything else, and for a query with no provenance", () => {
    expect(isEngineDerived(prov())).toBe(false);
    expect(isEngineDerived(prov({ dataSourceKind: "lake", attachedSources: [{ name: "X", kind: "sqlite", alias: "x" }] }))).toBe(false);
    expect(isEngineDerived(undefined)).toBe(false);
  });
});

describe("snapshotOf", () => {
  it("keeps other sources' rows exactly as before", () => {
    const snap = snapshotOf({ a: rows }, { a: prov({ queryId: "a" }) });
    expect(JSON.parse(snap.dataset!)).toEqual({ a: rows });
    expect(JSON.parse(snap.provenance!).a).toMatchObject({ rowCount: 3, dataHash: "sha256:bbb" });
  });

  it("keeps no engine rows, and no count or hash describing them", () => {
    const engineRows = [{ id: 9, email: "engine-secret@x.test" }];
    const snap = snapshotOf({ e: engineRows, p: rows }, { e: prov({ queryId: "e", dataSourceKind: "engine" }), p: prov({ queryId: "p" }) });
    const stored = JSON.parse(snap.dataset!);
    expect(stored.e).toEqual([]);
    expect(stored.p).toEqual(rows);
    const p = JSON.parse(snap.provenance!);
    expect(p.e).toMatchObject({ queryId: "e", rowCount: 0, dataHash: "", accessDeniedNote: ENGINE_NOT_STORED_NOTE, dataSourceKind: "engine" });
    expect(p.p.rowCount).toBe(3);
    expect(snap.dataset! + snap.provenance!).not.toContain("engine-secret");
  });

  it("keeps no rows of a query that joined an engine query either", () => {
    const snap = snapshotOf({ j: rows }, { j: prov({ queryId: "j", attachedSources: [{ name: "E", kind: "engine", alias: "e" }] }) });
    expect(JSON.parse(snap.dataset!).j).toEqual([]);
    expect(snap.dataset).not.toContain("a@x.test");
  });

  it("a snapshot too large to keep stores nothing, provenance included, as the writers always did", () => {
    const big = Array.from({ length: SNAPSHOT_MAX_CHARS / 10 }, (_, i) => ({ i, pad: "xxxxxxxxxx" }));
    expect(snapshotOf({ a: big }, { a: prov({ queryId: "a" }) })).toEqual({ dataset: null, provenance: null });
  });

  it("does not change what it was given", () => {
    const dataset = { e: rows };
    const provenance = { e: prov({ queryId: "e", dataSourceKind: "engine" }) };
    snapshotOf(dataset, provenance);
    expect(dataset.e).toBe(rows);
    expect(provenance.e.rowCount).toBe(3);
  });
});

describe("the parts", () => {
  it("withoutEngineRows and redactEngineProvenance work on their own, and cope with no provenance", () => {
    expect(withoutEngineRows({ a: rows }, undefined)).toEqual({ a: rows });
    expect(redactEngineProvenance(undefined)).toEqual({});
    expect(redactEngineProvenance({ e: prov({ dataSourceKind: "engine" }) }).e.dataHash).toBe("");
  });
});
