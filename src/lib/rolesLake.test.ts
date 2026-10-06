/**
 * The table page's buttons follow the routes' own rules (audit 2026-09-30,
 * C7): the Manage panel offered a developer visibility on a shared table the
 * route refuses, and an owner without a builder role schema changes the
 * route refuses too.
 */
import { describe, it, expect } from "vitest";
import { canEditLakeColumns, canEditLakeVisibility } from "./roles";

describe("canEditLakeColumns — lib/lake/tableAccess.ts's \"build\"", () => {
  it("builders only; owning the table isn't enough", () => {
    expect(canEditLakeColumns("admin")).toBe(true);
    expect(canEditLakeColumns("developer")).toBe(true);
    expect(canEditLakeColumns("viewer")).toBe(false);
    expect(canEditLakeColumns("executive")).toBe(false);
  });
});

describe("canEditLakeVisibility — the visibility route", () => {
  it("the owner, or an admin", () => {
    expect(canEditLakeVisibility("viewer", "u1", "u1")).toBe(true);
    expect(canEditLakeVisibility("admin", "u9", "u1")).toBe(true);
    expect(canEditLakeVisibility("admin", null, "u1")).toBe(true);
  });
  it("not a developer on a shared table, nor on someone else's", () => {
    expect(canEditLakeVisibility("developer", null, "u1")).toBe(false);
    expect(canEditLakeVisibility("developer", "u9", "u1")).toBe(false);
  });
});
