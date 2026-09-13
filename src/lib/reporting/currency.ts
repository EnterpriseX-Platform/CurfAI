/**
 * Currency resolution cascade — mirrors the theme cascade in
 * lib/reporting/themes.ts (report override → tenant default → "USD").
 *
 * Curf shipped hardcoded to USD for a while; every currency-formatted
 * surface (KPI cards, charts, tables, AI narration) now resolves through
 * this one function instead of assuming the reader's currency.
 */

export function resolveCurrency(
  reportCurrency?: string | null,
  tenantDefault?: string | null,
): string {
  return reportCurrency || tenantDefault || "USD";
}

/**
 * Curated list for the currency picker (tenant settings + report designer).
 * Not exhaustive — Intl.NumberFormat accepts any valid ISO 4217 code, this
 * is just the shortlist a picker shows. `label` includes the symbol so a
 * non-English-fluent admin can still recognise their currency at a glance.
 */
export const CURRENCY_OPTIONS: Array<{ code: string; label: string }> = [
  { code: "USD", label: "USD — US Dollar ($)" },
  { code: "THB", label: "THB — Thai Baht (฿)" },
  { code: "EUR", label: "EUR — Euro (€)" },
  { code: "GBP", label: "GBP — British Pound (£)" },
  { code: "JPY", label: "JPY — Japanese Yen (¥)" },
  { code: "CNY", label: "CNY — Chinese Yuan (¥)" },
  { code: "SGD", label: "SGD — Singapore Dollar (S$)" },
  { code: "INR", label: "INR — Indian Rupee (₹)" },
  { code: "AUD", label: "AUD — Australian Dollar (A$)" },
  { code: "CAD", label: "CAD — Canadian Dollar (C$)" },
  { code: "KRW", label: "KRW — South Korean Won (₩)" },
  { code: "VND", label: "VND — Vietnamese Dong (₫)" },
  { code: "IDR", label: "IDR — Indonesian Rupiah (Rp)" },
  { code: "PHP", label: "PHP — Philippine Peso (₱)" },
  { code: "MYR", label: "MYR — Malaysian Ringgit (RM)" },
];

const VALID_CODES = new Set(CURRENCY_OPTIONS.map((c) => c.code));
export function isKnownCurrencyCode(code: string): boolean {
  return VALID_CODES.has(code.toUpperCase());
}

/**
 * Extract just the symbol for a currency code (e.g. "THB" -> "฿"), for
 * formatters that build their own compact string instead of delegating to
 * Intl.NumberFormat's style:"currency" (e.g. ChartBlock's axis labels,
 * which need the symbol standalone to prefix a hand-rolled "1.2M").
 * Falls back to the code itself if Intl can't resolve a symbol.
 */
export function currencySymbol(code: string): string {
  try {
    const parts = new Intl.NumberFormat("en-US", { style: "currency", currency: code }).formatToParts(0);
    return parts.find((p) => p.type === "currency")?.value ?? code;
  } catch {
    return code;
  }
}
