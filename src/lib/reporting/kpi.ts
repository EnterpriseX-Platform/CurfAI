/**
 * KPI value math — the one place that turns a query's rows into the number a
 * KPI card shows. Shared by KpiBlock (viewer/designer/PDF), the Brief's
 * pinned metrics, and /api/reports/[id]/kpi-history (time-travel replay), so
 * the same block can never show one number on the card and another on the
 * Brief or in a replayed snapshot.
 */

export type KpiValueConfig = {
  valueField: string;
  /**
   * Client-side aggregation across ALL rows. "count" ignores valueField.
   * Absent → the query is expected to be a single-row aggregate; row 0 wins.
   */
  aggregate?: "sum" | "avg" | "count" | "min" | "max";
};

/**
 * Returns NaN when the value can't be produced (no rows, non-numeric field,
 * unknown aggregate) — callers that want `null` semantics wrap it with
 * `Number.isFinite`.
 */
export function computeKpiValue(cfg: KpiValueConfig, rows: ReadonlyArray<Record<string, unknown>>): number {
  if (!rows || rows.length === 0) return NaN;
  if (cfg.aggregate) {
    if (cfg.aggregate === "count") return rows.length;
    // `Number(null)` is 0 and `Number("")` is 0 — a missing cell must not
    // drag an average down or become the minimum, so blanks are skipped
    // before the numeric filter, not counted as zero.
    const nums = rows
      .map((r) => r[cfg.valueField])
      .filter((v) => v != null && v !== "")
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n));
    if (nums.length === 0) return NaN;
    switch (cfg.aggregate) {
      case "sum": return nums.reduce((s, v) => s + v, 0);
      case "avg": return nums.reduce((s, v) => s + v, 0) / nums.length;
      case "min": return Math.min(...nums);
      case "max": return Math.max(...nums);
      default: return NaN;
    }
  }
  const raw = rows[0]?.[cfg.valueField];
  if (raw == null) return NaN;
  return Number(raw);
}

/** The comparison value (row 0 of `compareField`), or undefined when absent/non-numeric. */
export function pickKpiCompare(rows: ReadonlyArray<Record<string, unknown>>, compareField?: string): number | undefined {
  if (!compareField || !rows || rows.length === 0) return undefined;
  const n = Number(rows[0]?.[compareField]);
  return Number.isFinite(n) ? n : undefined;
}

/** (value - compare) / compare, or undefined when the comparison is unusable. */
export function kpiDelta(value: number, compare: number | undefined): number | undefined {
  if (compare == null || !Number.isFinite(compare) || compare === 0 || !Number.isFinite(value)) return undefined;
  return (value - compare) / compare;
}
