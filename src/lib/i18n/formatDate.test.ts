import { describe, it, expect } from "vitest";
import { longDate, intlLocale } from "./formatDate";

const d = new Date("2026-09-24T09:00:00Z");

describe("formatDate", () => {
  it("shows the Buddhist-era year in Thai by default, Gregorian on request", () => {
    expect(longDate(d, "th")).toContain("2569");
    expect(longDate(d, "th", "ce")).toContain("2026");
    expect(longDate(d, "th", "ce")).not.toContain("2569");
  });
  it("ignores the era outside Thai", () => {
    expect(intlLocale("en", "be")).toBe("en-GB");
    expect(longDate(d, "en")).toMatch(/September/);
  });
});
