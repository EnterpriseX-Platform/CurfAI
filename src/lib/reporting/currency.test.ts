/**
 * Currency was hardcoded to USD across every block renderer before this
 * cascade existed. These tests pin the fallback chain (report -> tenant ->
 * "USD") and the symbol lookup used by formatters that build their own
 * compact strings instead of delegating to Intl's style:"currency".
 */
import { describe, it, expect } from "vitest";
import { resolveCurrency, currencySymbol, isKnownCurrencyCode } from "./currency";

describe("resolveCurrency", () => {
  it("prefers the report override", () => {
    expect(resolveCurrency("THB", "USD")).toBe("THB");
  });

  it("falls back to the tenant default when the report has none", () => {
    expect(resolveCurrency(null, "THB")).toBe("THB");
    expect(resolveCurrency(undefined, "EUR")).toBe("EUR");
  });

  it("falls back to USD when neither is set", () => {
    expect(resolveCurrency(null, null)).toBe("USD");
    expect(resolveCurrency(undefined, undefined)).toBe("USD");
  });

  it("treats an empty string as unset, not a valid override", () => {
    expect(resolveCurrency("", "THB")).toBe("THB");
  });
});

describe("currencySymbol", () => {
  it("resolves known ISO codes to their symbol", () => {
    expect(currencySymbol("USD")).toBe("$");
    expect(currencySymbol("THB")).toBe("THB");
    expect(currencySymbol("EUR")).toBe("€");
  });

  it("falls back to the code itself for an invalid input", () => {
    expect(currencySymbol("NOT_A_CODE")).toBe("NOT_A_CODE");
  });
});

describe("isKnownCurrencyCode", () => {
  it("accepts codes from the curated picker list, case-insensitively", () => {
    expect(isKnownCurrencyCode("THB")).toBe(true);
    expect(isKnownCurrencyCode("thb")).toBe(true);
  });

  it("rejects codes outside the curated list", () => {
    expect(isKnownCurrencyCode("XYZ")).toBe(false);
  });
});
