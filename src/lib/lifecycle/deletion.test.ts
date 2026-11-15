import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_GRACE_DAYS, daysUntil, graceDays, purgeDate } from "./deletion";

const env = process.env as Record<string, string | undefined>;
const saved = { grace: env.CURF_DELETION_GRACE_DAYS, node: env.NODE_ENV };
afterEach(() => { env.CURF_DELETION_GRACE_DAYS = saved.grace; env.NODE_ENV = saved.node; });

describe("grace period", () => {
  it("is 30 days unless configured", () => {
    delete env.CURF_DELETION_GRACE_DAYS;
    expect(graceDays()).toBe(DEFAULT_GRACE_DAYS);
    expect(DEFAULT_GRACE_DAYS).toBe(30);
  });
  it("takes CURF_DELETION_GRACE_DAYS, clamped to 1-365 in production", () => {
    env.NODE_ENV = "production";
    env.CURF_DELETION_GRACE_DAYS = "7"; expect(graceDays()).toBe(7);
    env.CURF_DELETION_GRACE_DAYS = "0"; expect(graceDays()).toBe(1);
    env.CURF_DELETION_GRACE_DAYS = "9999"; expect(graceDays()).toBe(365);
    env.CURF_DELETION_GRACE_DAYS = "soon"; expect(graceDays()).toBe(30);
  });
  it("allows 0 outside production, for tests", () => {
    env.NODE_ENV = "test";
    env.CURF_DELETION_GRACE_DAYS = "0"; expect(graceDays()).toBe(0);
  });
  it("computes the purge date and the days left", () => {
    const from = new Date("2026-11-13T00:00:00Z");
    expect(purgeDate(from, 30).toISOString()).toBe("2026-12-13T00:00:00.000Z");
    expect(daysUntil(new Date("2026-12-13T00:00:00Z"), from)).toBe(30);
    expect(daysUntil(new Date("2026-11-13T06:00:00Z"), from)).toBe(1); // part of a day counts as a day
    expect(daysUntil(new Date("2026-11-01T00:00:00Z"), from)).toBe(0); // never negative
    expect(daysUntil(null, from)).toBeNull();
  });
});
