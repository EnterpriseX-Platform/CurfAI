"use client";
/**
 * ThemeProvider — wraps a report tree (viewer / designer canvas / export
 * pipeline) and exposes the resolved design tokens to every block.
 *
 * Resolution order (the personalization cascade — only the first slice is
 * implemented today; user preferences and tenant brand are wired in later
 * slices but the lookup is already shaped for them):
 *
 *   user.themeOverride  →  report.theme  →  tenant.defaultTheme  →  "default"
 *
 * Blocks consume the resolved theme via `useTheme()` (or the hookless
 * helpers `paletteFor()` / `rampFor()` from lib/reporting/themes.ts when
 * called outside a React tree, e.g. PDF export workers).
 */
import { createContext, useContext, useMemo } from "react";
import { resolveTheme, type ResolvedTheme } from "@/lib/reporting/themes";
import { resolveChartStyle, type ResolvedChartStyle } from "@/lib/reporting/chartStyles";
import type { Theme, ChartStyle } from "@/lib/reporting/schema";

const ThemeContext = createContext<ResolvedTheme>(resolveTheme("default"));
/**
 * Chart style rides in its own context rather than being folded into
 * ResolvedTheme: it resolves from a different set of fields, and a block that
 * only needs colour shouldn't re-render when the form changes (or vice versa).
 */
const ChartStyleContext = createContext<ResolvedChartStyle>(resolveChartStyle("classic"));

export function useTheme(): ResolvedTheme {
  return useContext(ThemeContext);
}

/** Resolved chart *form* tokens — see lib/reporting/chartStyles.ts. */
export function useChartStyle(): ResolvedChartStyle {
  return useContext(ChartStyleContext);
}

export function ThemeProvider({
  reportTheme,
  userOverride,
  tenantDefault,
  tenantCustomPalette,
  reportChartStyle,
  tenantDefaultChartStyle,
  children,
}: {
  /** Theme set on the report itself (Report.theme). */
  reportTheme?: Theme | string | null;
  /** User-level override (User.preferencesJson.themeOverride). */
  userOverride?: Theme | string | null;
  /** Tenant-level fallback (Tenant.brandJson.defaultTheme). */
  tenantDefault?: Theme | string | null;
  /** Chart style set on the report itself (Report.chartStyle). */
  reportChartStyle?: ChartStyle | string | null;
  /** Tenant-level chart style fallback (Tenant.brandJson.defaultChartStyle). */
  tenantDefaultChartStyle?: ChartStyle | string | null;
  /**
   * Tenant-level custom 10-color palette (Tenant.brandJson.customPalette).
   * When set on a Business tenant via gov.custom_branding, it overrides
   * the resolved theme's palette[] entirely while keeping the theme's
   * ramps + semantic + fonts intact. Useful for workspaces that want
   * their brand colors on charts without designing a full theme.
   */
  tenantCustomPalette?: string[];
  children: React.ReactNode;
}) {
  const resolved = useMemo(() => {
    const base = resolveTheme(userOverride ?? reportTheme ?? tenantDefault ?? "default");
    if (tenantCustomPalette && tenantCustomPalette.length >= 1) {
      // Spread to a copy so the consumer doesn't mutate THEME_PRESETS.
      return { ...base, palette: [...tenantCustomPalette, ...base.palette].slice(0, 10) };
    }
    return base;
  }, [userOverride, reportTheme, tenantDefault, tenantCustomPalette]);
  const chartStyle = useMemo(
    () => resolveChartStyle(reportChartStyle ?? tenantDefaultChartStyle ?? "classic"),
    [reportChartStyle, tenantDefaultChartStyle],
  );
  return (
    <ThemeContext.Provider value={resolved}>
      <ChartStyleContext.Provider value={chartStyle}>{children}</ChartStyleContext.Provider>
    </ThemeContext.Provider>
  );
}
