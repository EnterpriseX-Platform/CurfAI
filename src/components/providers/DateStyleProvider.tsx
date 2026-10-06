"use client";
/**
 * DateStyleProvider — how dates read inside a report tree (viewer, designer
 * canvas, PDF capture). Blocks consume it via `useDateStyle()` and pass it
 * to formatCell / thaiDateLabel (lib/reporting/format.ts).
 *
 * Resolution: the reader's language (useT) with
 *
 *   report.dateEra  →  the reader's era preference (rd_era)  →  "be"
 *
 * Kept beside CurrencyProvider for the same reason: it's a data-reading
 * setting, not a design token.
 */
import { createContext, useContext, useMemo } from "react";
import { useT } from "@/lib/i18n/LocaleContext";
import { resolveDateStyle, type DateStyle } from "@/lib/reporting/format";
import type { Era } from "@/lib/i18n/formatDate";

const DateStyleContext = createContext<DateStyle | undefined>(undefined);

/** Outside a report tree this falls back to the reader's own language and era. */
export function useDateStyle(): DateStyle {
  const ctx = useContext(DateStyleContext);
  const { locale, era } = useT();
  return ctx ?? { locale, era };
}

export function DateStyleProvider({ reportEra, children }: { reportEra?: Era | null; children: React.ReactNode }) {
  const { locale, era } = useT();
  const value = useMemo<DateStyle>(() => resolveDateStyle(locale, era, reportEra), [locale, era, reportEra]);
  return <DateStyleContext.Provider value={value}>{children}</DateStyleContext.Provider>;
}
