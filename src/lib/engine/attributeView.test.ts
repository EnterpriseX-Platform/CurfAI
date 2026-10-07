import { describe, it, expect } from "vitest";
import { allAttributeNames, driftExamples, driftState, failedSyncs, filterMembers, heldAttributes, memberLabel, sortMembers, syncWouldHelp, type Member } from "./attributeView";

const m = (userId: string, email: string, name: string | null, role: string, attributes: Record<string, string[]> = {}): Member => ({ userId, email, name, role, attributes });
const members = [
  m("1", "zed@x.com", "Zed", "viewer", { agency_code: ["A001"] }),
  m("2", "amy@x.com", null, "admin"),
  m("3", "bob@x.com", "Bob", "editor", { region: ["North"], agency_code: [] }),
];

describe("members", () => {
  it("labels by name, else email", () => {
    expect(memberLabel(members[0])).toBe("Zed");
    expect(memberLabel(members[1])).toBe("amy@x.com");
  });
  it("filters by name, email, role, attribute name or value", () => {
    expect(filterMembers(members, "").length).toBe(3);
    expect(filterMembers(members, "BOB").map((x) => x.userId)).toEqual(["3"]);
    expect(filterMembers(members, "admin").map((x) => x.userId)).toEqual(["2"]);
    expect(filterMembers(members, "a001").map((x) => x.userId)).toEqual(["1"]);
    expect(filterMembers(members, "region").map((x) => x.userId)).toEqual(["3"]);
    expect(filterMembers(members, "nobody")).toEqual([]);
  });
  it("sorts both ways without changing the input", () => {
    expect(sortMembers(members, "name", "asc").map((x) => x.userId)).toEqual(["2", "3", "1"]);
    expect(sortMembers(members, "name", "desc").map((x) => x.userId)).toEqual(["1", "3", "2"]);
    expect(sortMembers(members, "role", "asc").map((x) => x.role)).toEqual(["admin", "editor", "viewer"]);
    expect(members[0].userId).toBe("1");
  });
  it("lists held attributes, ignoring empty ones", () => {
    expect(heldAttributes(members[2])).toEqual(["region"]);
    expect(allAttributeNames(["zone"], members)).toEqual(["agency_code", "region", "zone"]);
  });
});

describe("sync and drift", () => {
  it("picks out the engines that failed", () => {
    expect(failedSyncs([{ dataSourceId: "a", name: "A", ok: true }, { dataSourceId: "b", name: "B", ok: false, error: "down" }]).map((s) => s.name)).toEqual(["B"]);
    expect(failedSyncs(undefined)).toEqual([]);
  });
  it("maps subjects to emails, keeping the id for people no longer members", () => {
    expect(driftExamples([{ subject: "1", attribute: "a", value: "v" }, { subject: "gone", attribute: "a", value: "w" }], members)).toEqual([
      { who: "zed@x.com", attribute: "a", value: "v" },
      { who: "gone", attribute: "a", value: "w" },
    ]);
    expect(driftExamples(undefined, members)).toEqual([]);
  });
  it("decides each engine's state", () => {
    const base = { dataSourceId: "a", name: "A" };
    expect(driftState({ ...base, ok: false, error: "x" })).toBe("unreachable");
    expect(driftState({ ...base, ok: true, inSync: true, complete: true })).toBe("inSync");
    expect(driftState({ ...base, ok: true, inSync: false, missingOnEngine: 2 })).toBe("differs");
    expect(driftState({ ...base, ok: true, complete: false, extraOnEngine: 1 })).toBe("differs");
    expect(driftState({ ...base, ok: true, complete: false })).toBe("incomplete");
  });
  it("offers Sync only when it could change something", () => {
    const base = { dataSourceId: "a", name: "A" };
    expect(syncWouldHelp([{ ...base, ok: true, inSync: true }])).toBe(false);
    expect(syncWouldHelp([{ ...base, ok: false }])).toBe(false);
    expect(syncWouldHelp([{ ...base, ok: true, missingOnEngine: 1 }])).toBe(true);
  });
});
