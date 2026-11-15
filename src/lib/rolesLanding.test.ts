/**
 * landingPathFor(): where sign-in and "/" send a member. Every edition must
 * land on a page it ships — the Community edition has no Brief and no
 * Executive view, and used to send everyone to /brief, a 404 there.
 */
import { describe, it, expect } from "vitest";
import { landingPathFor } from "./roles";
import { EDITION } from "./ee/edition";

describe("landingPathFor", () => {
  it.runIf(EDITION !== "community")("sends executives and viewers to the Executive view, everyone else to the Brief", () => {
    expect(landingPathFor("executive")).toBe("/executive");
    expect(landingPathFor("viewer")).toBe("/executive");
    expect(landingPathFor("admin")).toBe("/brief");
    expect(landingPathFor(null)).toBe("/brief");
  });

  it.runIf(EDITION === "community")("opens every role on Reports in the Community edition", () => {
    for (const role of ["admin", "editor", "viewer", "executive", null]) expect(landingPathFor(role)).toBe("/reports");
  });
});
