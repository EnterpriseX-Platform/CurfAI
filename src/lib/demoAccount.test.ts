import { describe, expect, it } from "vitest";
import { isDemoAccountEmail } from "./demoAccount";

describe("demo visitors' throwaway accounts", () => {
  it("accepts exactly what /api/try creates", () => {
    expect(isDemoAccountEmail("try-0123456789ab@curf.demo")).toBe(true);
    expect(isDemoAccountEmail("  TRY-0123456789AB@curf.demo ")).toBe(true);
  });
  it("accepts nothing else, so a password sign-in can't be used on a real account", () => {
    for (const e of ["admin@curf.local", "try-1@curf.demo", "try-0123456789ab@curf.demo.evil.com", "x-try-0123456789ab@curf.demo", "try-0123456789ab@curf.demo\n@evil.com", "try-0123456789abc@curf.demo", "", null, undefined]) {
      expect(isDemoAccountEmail(e as any), String(e)).toBe(false);
    }
  });
});
