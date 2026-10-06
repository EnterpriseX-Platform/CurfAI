/**
 * Currency was hardcoded to USD across every block renderer before this
 * cascade existed. These tests pin the fallback chain (report -> tenant ->
 * DEFAULT_CURRENCY, baht) and the symbol lookup used by formatters that build their own
 * compact strings instead of delegating to Intl's style:"currency".
 */
import { describe, it, expect } from "vitest";
import { resolveCurrency, currencySymbol, currencyDisplay, isKnownCurrencyCode, DEFAULT_CURRENCY } from "./currency";
import { formatCurrency, formatMetricCompact } from "./format";

describe("resolveCurrency", () => {
  it("prefers the report override", () => {
    expect(resolveCurrency("THB", "USD")).toBe("THB");
  });

  it("falls back to the tenant default when the report has none", () => {
    expect(resolveCurrency(null, "THB")).toBe("THB");
    expect(resolveCurrency(undefined, "EUR")).toBe("EUR");
  });

  it("falls back to baht when neither is set", () => {
    expect(DEFAULT_CURRENCY).toBe("THB");
    expect(resolveCurrency(null, null)).toBe("THB");
    expect(resolveCurrency(undefined, undefined)).toBe("THB");
  });

  it("treats an empty string as unset, not a valid override", () => {
    expect(resolveCurrency("", "THB")).toBe("THB");
  });
});

describe("currencySymbol", () => {
  it("resolves known ISO codes to their symbol", () => {
    expect(currencySymbol("USD")).toBe("$");
    expect(currencySymbol("THB")).toBe("฿");
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

describe("currencyDisplay", () => {
  it("shows baht as ฿, not \"THB 1,234.50\"", () => {
    expect(currencyDisplay("THB")).toBe("narrowSymbol");
    expect(formatCurrency(1234.5, "THB")).toBe("฿1,234.50");
    expect(formatMetricCompact(10_500_000_000, "currency", "THB")).toBe("฿10.5B");
    // No currency given: the default, baht.
    expect(formatCurrency(1234.5)).toBe("฿1,234.50");
  });

  it("keeps en-US's own symbols, and never shows another dollar as a bare $", () => {
    expect(formatCurrency(1234.5, "USD")).toBe("$1,234.50");
    expect(currencySymbol("AUD")).toBe("A$");
    expect(currencySymbol("SGD")).toBe("SGD");
    expect(currencySymbol("MYR")).toBe("RM");
  });
});
