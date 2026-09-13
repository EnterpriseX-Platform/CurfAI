"use client";
/**
 * CurrencyProvider — wraps a report tree (viewer / designer canvas / export
 * pipeline) and exposes the resolved currency code to every block.
 *
 * Resolution order (mirrors ThemeProvider's cascade):
 *
 *   report.currency  →  tenant.currency  →  "USD"
 *
 * Blocks consume it via `useCurrency()`. Kept as its own provider (not
 * folded into ThemeProvider) because currency isn't a design token — it's
 * a data-correctness setting that non-Business tenants must also control.
 */
import { createContext, useContext, useMemo } from "react";
import { resolveCurrency } from "@/lib/reporting/currency";

const CurrencyContext = createContext<string>("USD");

export function useCurrency(): string {
  return useContext(CurrencyContext);
}

export function CurrencyProvider({
  reportCurrency,
  tenantCurrency,
  children,
}: {
  /** Currency set on the report itself (Report.currency). */
  reportCurrency?: string | null;
  /** Tenant-level default (Tenant.currency). */
  tenantCurrency?: string | null;
  children: React.ReactNode;
}) {
  const resolved = useMemo(
    () => resolveCurrency(reportCurrency, tenantCurrency),
    [reportCurrency, tenantCurrency],
  );
  return <CurrencyContext.Provider value={resolved}>{children}</CurrencyContext.Provider>;
}
