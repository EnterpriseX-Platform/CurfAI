/**
 * OWASP A09:2025 regression — the failed-login burst detector must be
 * edge-triggered (alert once when the threshold is first crossed) rather
 * than level-triggered (re-alert on every tick while the count stays high),
 * or a sustained attack would spam the webhook every 5 minutes for as long
 * as it runs.
 */
import { describe, it, expect } from "vitest";
import { shouldAlertOnFailedLogins } from "./opsTicks";

describe("shouldAlertOnFailedLogins", () => {
  it("does not alert below the threshold", () => {
    expect(shouldAlertOnFailedLogins(4, 0)).toBe(false);
  });

  it("alerts when the current window first crosses the threshold", () => {
    expect(shouldAlertOnFailedLogins(5, 4)).toBe(true);
  });

  it("does not re-alert while the burst stays above the threshold (already fired last window)", () => {
    expect(shouldAlertOnFailedLogins(8, 6)).toBe(false);
  });

  it("alerts again once the count drops back under and crosses a second time", () => {
    expect(shouldAlertOnFailedLogins(2, 8)).toBe(false); // dropped back under — no alert on the drop itself
    expect(shouldAlertOnFailedLogins(5, 2)).toBe(true); // crosses again later
  });

  it("respects a custom threshold", () => {
    expect(shouldAlertOnFailedLogins(3, 2, 3)).toBe(true);
    expect(shouldAlertOnFailedLogins(3, 3, 3)).toBe(false);
  });
});
