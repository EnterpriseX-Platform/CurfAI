import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_VALUES_MAX, ENTITLEMENT_BATCH_SIZE, driftBetween, groupByPair, groupImport, inBatches, isValidAttributeName, normaliseValues, reconcileEntries,
} from "./attributeModel";

const row = (subject: string, attribute: string, value: string) => ({ subject, attribute, value });

describe("isValidAttributeName", () => {
  it("is the engine's own rule: a letter, then letters, digits, underscores, at most 64", () => {
    for (const ok of ["agency_code", "A", "region2", "a".repeat(64)]) expect(isValidAttributeName(ok), ok).toBe(true);
    for (const bad of ["", "1abc", "_x", "a-b", "a b", "a.b", "a".repeat(65), "ก", "x;y", 5, null, undefined]) expect(isValidAttributeName(bad as any), String(bad)).toBe(false);
  });
});

describe("normaliseValues", () => {
  it("trims, drops empties and duplicates, keeps order, and takes numbers as text", () => {
    expect(normaliseValues([" A001 ", "", "  ", "A002", "A001", 7])).toEqual({ ok: true, values: ["A001", "A002", "7"] });
    expect(normaliseValues([])).toEqual({ ok: true, values: [] });
  });
  it("refuses what is not a list of text, an over-long value, control characters, and too many values", () => {
    expect(normaliseValues("A001")).toMatchObject({ ok: false });
    expect(normaliseValues([{}])).toMatchObject({ ok: false });
    expect(normaliseValues([null])).toMatchObject({ ok: false });
    expect(normaliseValues(["x".repeat(201)])).toMatchObject({ ok: false });
    expect(normaliseValues(["x".repeat(200)])).toMatchObject({ ok: true });
    expect(normaliseValues(["a\nb"])).toMatchObject({ ok: false });
    expect(normaliseValues(["a\u0000b"])).toMatchObject({ ok: false });
    expect(normaliseValues(Array.from({ length: ATTRIBUTE_VALUES_MAX + 1 }, (_, i) => `v${i}`))).toMatchObject({ ok: false });
    expect(normaliseValues(Array.from({ length: ATTRIBUTE_VALUES_MAX }, (_, i) => `v${i}`))).toMatchObject({ ok: true });
  });
  it("keeps Thai text as it is", () => {
    expect(normaliseValues([" กรุงเทพ "])).toEqual({ ok: true, values: ["กรุงเทพ"] });
  });
});

describe("groupByPair", () => {
  it("collects each person's values per attribute, once each", () => {
    const g = groupByPair([row("u1", "agency", "A"), row("u1", "agency", "B"), row("u1", "agency", "A"), row("u1", "region", "N"), row("u2", "agency", "A")]);
    expect([...g.values()]).toEqual([
      { subject: "u1", attribute: "agency", values: ["A", "B"] },
      { subject: "u1", attribute: "region", values: ["N"] },
      { subject: "u2", attribute: "agency", values: ["A"] },
    ]);
  });
});

describe("reconcileEntries: making the engine hold what Curf holds", () => {
  it("sends nothing when they already agree, whatever the order", () => {
    expect(reconcileEntries(
      [row("u1", "agency", "A"), row("u1", "agency", "B")],
      [row("u1", "agency", "B"), row("u1", "agency", "A")],
    )).toEqual([]);
    expect(reconcileEntries([], [])).toEqual([]);
  });

  it("sends the full set, not the difference, for a pair that differs (the engine replaces)", () => {
    expect(reconcileEntries(
      [row("u1", "agency", "A"), row("u1", "agency", "B")],
      [row("u1", "agency", "A")],
    )).toEqual([{ subject: "u1", attribute: "agency", values: ["A", "B"] }]);
    expect(reconcileEntries(
      [row("u1", "agency", "A")],
      [row("u1", "agency", "A"), row("u1", "agency", "STALE")],
    )).toEqual([{ subject: "u1", attribute: "agency", values: ["A"] }]);
  });

  it("adds a person the engine does not know, and removes one Curf no longer holds anything for", () => {
    expect(reconcileEntries([row("new", "agency", "A")], [row("gone", "agency", "Z")])).toEqual([
      { subject: "new", attribute: "agency", values: ["A"] },
      { subject: "gone", attribute: "agency", values: [] },
    ]);
  });

  it("does not touch a pair on the other side's attribute, and treats pairs independently", () => {
    expect(reconcileEntries(
      [row("u1", "agency", "A"), row("u1", "region", "N")],
      [row("u1", "agency", "A"), row("u1", "region", "S")],
    )).toEqual([{ subject: "u1", attribute: "region", values: ["N"] }]);
  });
});

describe("driftBetween", () => {
  it("is in sync when both hold the same, and says nothing is missing or extra", () => {
    expect(driftBetween([row("u1", "a", "X")], [row("u1", "a", "X")])).toEqual({ inSync: true, missingOnEngine: [], extraOnEngine: [] });
  });
  it("names what the engine lacks (the person sees too little) and what it has that Curf does not (too much)", () => {
    const d = driftBetween([row("u1", "a", "X"), row("u1", "a", "Y")], [row("u1", "a", "X"), row("u2", "a", "Z")]);
    expect(d.inSync).toBe(false);
    expect(d.missingOnEngine).toEqual([row("u1", "a", "Y")]);
    expect(d.extraOnEngine).toEqual([row("u2", "a", "Z")]);
  });
  it("counts a repeated row once", () => {
    expect(driftBetween([row("u1", "a", "X"), row("u1", "a", "X")], []).missingOnEngine).toHaveLength(1);
  });
});

describe("inBatches", () => {
  it("splits to what the engine accepts in one call", () => {
    expect(ENTITLEMENT_BATCH_SIZE).toBe(500);
    const batches = inBatches(Array.from({ length: 1201 }, (_, i) => i));
    expect(batches.map((b) => b.length)).toEqual([500, 500, 201]);
    expect(inBatches([])).toEqual([]);
  });
});

describe("groupImport", () => {
  it("groups lines into one set per person and attribute, with emails lower-cased", () => {
    expect(groupImport([
      { email: "Somchai@A001.go.th", name: "agency", value: "A001" },
      { email: "somchai@a001.go.th", name: "agency", value: "A002" },
      { email: "somchai@a001.go.th", name: "agency", value: "A001" },
      { email: "pim@a002.go.th", name: "region", value: "N" },
    ])).toEqual({ ok: true, sets: [
      { email: "somchai@a001.go.th", name: "agency", values: ["A001", "A002"] },
      { email: "pim@a002.go.th", name: "region", values: ["N"] },
    ] });
  });
  it("says which row is wrong", () => {
    expect(groupImport([{ email: "a@b.c", name: "ok", value: "1" }, { email: "nobody", name: "ok", value: "1" }])).toMatchObject({ ok: false, row: 2 });
    expect(groupImport([{ email: "a@b.c", name: "1bad", value: "1" }])).toMatchObject({ ok: false, row: 1 });
  });
  it("refuses a value the engine would not accept", () => {
    expect(groupImport([{ email: "a@b.c", name: "ok", value: "x".repeat(201) }])).toMatchObject({ ok: false });
  });
});
