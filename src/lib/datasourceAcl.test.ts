/**
 * canSeeDataSource() is the authoritative gate deciding whether a user can
 * use a given DataSource connection — including "Just me" private uploads
 * and role-scoped connections. It had zero test coverage despite being the
 * function most directly responsible for keeping one tenant member's
 * private credential-bearing connection away from another. Pins the three
 * visibility modes and their admin-bypass rules exactly.
 */
import { describe, it, expect } from "vitest";
import { canSeeDataSource, readVisibility, writeVisibility, filterVisibleDataSources } from "./datasourceAcl";

const admin = { id: "u_admin", isAdmin: true, roles: [] as string[] };
const memberWithRole = { id: "u_member", isAdmin: false, roles: ["finance"] };
const memberNoRole = { id: "u_other", isAdmin: false, roles: ["ops"] };
const owner = { id: "u_owner", isAdmin: false, roles: [] as string[] };

describe("canSeeDataSource — tenant mode (default)", () => {
  it("everyone in the tenant can see it, admin or not", () => {
    const row = { visibleToRolesJson: "[]", ownerUserId: null };
    expect(canSeeDataSource(row, admin)).toBe(true);
    expect(canSeeDataSource(row, memberNoRole)).toBe(true);
  });
});

describe("canSeeDataSource — roles mode", () => {
  const row = { visibleToRolesJson: JSON.stringify(["finance"]), ownerUserId: null };

  it("a member with a matching role can see it", () => {
    expect(canSeeDataSource(row, memberWithRole)).toBe(true);
  });

  it("a member without a matching role cannot", () => {
    expect(canSeeDataSource(row, memberNoRole)).toBe(false);
  });

  it("admin bypasses the role restriction", () => {
    expect(canSeeDataSource(row, admin)).toBe(true);
  });
});

describe("canSeeDataSource — owner_only mode (\"Just me\")", () => {
  const row = { visibleToRolesJson: "[]", ownerUserId: "u_owner" };

  it("the owner can see it", () => {
    expect(canSeeDataSource(row, owner)).toBe(true);
  });

  it("a non-owner tenant member cannot", () => {
    expect(canSeeDataSource(row, memberNoRole)).toBe(false);
  });

  it("admin does NOT bypass owner_only — that's the entire point of the mode", () => {
    expect(canSeeDataSource(row, admin)).toBe(false);
  });

  it("ownerUserId takes precedence even if visibleToRolesJson is also set (shouldn't happen, but fail closed)", () => {
    const conflicting = { visibleToRolesJson: JSON.stringify(["finance"]), ownerUserId: "u_owner" };
    expect(canSeeDataSource(conflicting, memberWithRole)).toBe(false);
  });
});

describe("readVisibility / writeVisibility round-trip", () => {
  it("tenant mode round-trips", () => {
    const cols = writeVisibility({ mode: "tenant" });
    expect(readVisibility(cols)).toEqual({ mode: "tenant" });
  });

  it("roles mode round-trips with the exact role list", () => {
    const cols = writeVisibility({ mode: "roles", roles: ["a", "b"] });
    expect(readVisibility(cols)).toEqual({ mode: "roles", roles: ["a", "b"] });
  });

  it("owner_only mode round-trips with the owner id", () => {
    const cols = writeVisibility({ mode: "owner_only", ownerUserId: "u1" });
    expect(readVisibility(cols)).toEqual({ mode: "owner_only", ownerUserId: "u1" });
  });

  it("corrupt visibleToRolesJson fails closed to tenant mode, not a crash", () => {
    expect(readVisibility({ visibleToRolesJson: "{not json", ownerUserId: null })).toEqual({ mode: "tenant" });
  });
});

describe("filterVisibleDataSources", () => {
  it("filters a mixed list down to only what the caller can see", () => {
    const rows = [
      { id: "r1", visibleToRolesJson: "[]", ownerUserId: null },
      { id: "r2", visibleToRolesJson: "[]", ownerUserId: "u_owner" },
      { id: "r3", visibleToRolesJson: JSON.stringify(["finance"]), ownerUserId: null },
    ];
    const visible = filterVisibleDataSources(rows, memberNoRole);
    expect(visible.map((r) => r.id)).toEqual(["r1"]);
  });
});
