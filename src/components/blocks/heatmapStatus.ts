/**
 * Status → semantic-tone resolution shared by the heatmap tiles block and
 * any other surface that renders the same "status board" shape (currently
 * the Analytic App Executive tab's delivery heatmap).
 *
 * Deliberately its OWN module, without "use client": HeatmapBlock.tsx has
 * that directive (it calls useTheme()/useCurrency()), and importing a named
 * export from a "use client" file into a Server Component turns it into an
 * opaque client reference — even a plain object — which crashes with
 * "Attempted to call X from the server but X is on the client" the moment a
 * Server Component (DeliveryHeatmap.tsx) tries to read it. Splitting the
 * plain data out of the client module is the fix; both sides still resolve
 * a status string to the same five tones from one table.
 */

/** Accepted spellings for each semantic variant, lowercased. */
export const STATUS_ALIASES: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = {
  success: "success", ok: "success", good: "success", green: "success", healthy: "success", "on-track": "success",
  warning: "warning", warn: "warning", amber: "warning", risk: "warning", "at-risk": "warning",
  danger: "danger", critical: "danger", bad: "danger", red: "danger", late: "danger", blocked: "danger",
  info: "info", active: "info", blue: "info",
  neutral: "neutral", none: "neutral", unknown: "neutral", idle: "neutral",
};

/** Generic, tone-only labels — the tiles' own statusField values (shown in
 *  each tile already) carry the domain-specific wording; the legend just
 *  needs to say what each color MEANS. Ordered by severity for a legend
 *  that reads left-to-right as "best to worst" rather than data order. */
export const STATUS_LEGEND_ORDER: Array<{ key: "success" | "warning" | "danger" | "info" | "neutral"; label: string }> = [
  { key: "success", label: "On plan" },
  { key: "warning", label: "Watch" },
  { key: "danger", label: "Critical" },
  { key: "info", label: "Active" },
  { key: "neutral", label: "No status" },
];
