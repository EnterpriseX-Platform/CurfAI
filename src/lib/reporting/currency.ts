/**
 * Currency resolution cascade — mirrors the theme cascade in
 * lib/reporting/themes.ts (report override → tenant default → DEFAULT_CURRENCY).
 *
 * Curf shipped hardcoded to USD for a while; every currency-formatted
 * surface (KPI cards, charts, tables, AI narration) now resolves through
 * this one function instead of assuming the reader's currency.
 */

/**
 * The currency a workspace reads in until an admin picks one (Tenant.currency
 * null). Curf's customers are Thai businesses and agencies, so baht — a
 * workspace that reports in dollars sets USD under Admin → Workspace.
 */
export const DEFAULT_CURRENCY = "THB";

export function resolveCurrency(
  reportCurrency?: string | null,
  tenantDefault?: string | null,
): string {
  return reportCurrency || tenantDefault || DEFAULT_CURRENCY;
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
    const parts = new Intl.NumberFormat("en-US", { style: "currency", currency: code, currencyDisplay: currencyDisplay(code) }).formatToParts(0);
    return parts.find((p) => p.type === "currency")?.value ?? code;
  } catch {
    return code;
  }
}

/**
 * How Intl should show a currency in Curf's en-US number formatting. en-US
 * has its own symbol for the dollar, euro, pound, yen, won… but spells baht
 * out as "THB" ("THB 1,234.50"), where a Thai reader expects "฿". So: the
 * narrow symbol when en-US has none of its own (฿, Rp, RM) — unless that
 * narrow symbol is a bare "$", which would read as US dollars (SGD stays
 * "SGD"). Pass as `currencyDisplay` wherever Intl formats a currency.
 */
export function currencyDisplay(code: string): "symbol" | "narrowSymbol" {
  try {
    const part = (currencyDisplay: "symbol" | "narrowSymbol") =>
      new Intl.NumberFormat("en-US", { style: "currency", currency: code, currencyDisplay }).formatToParts(0)
        .find((p) => p.type === "currency")?.value;
    if (part("symbol") !== code.toUpperCase()) return "symbol";
    const narrow = part("narrowSymbol");
    return narrow && !narrow.includes("$") ? "narrowSymbol" : "symbol";
  } catch {
    return "symbol";
  }
}
