/**
 * The "metric:<slug>" queryId a metric-backed block points at, instead of a
 * report-local query. See enrichDatasetWithMetrics() in lib/metrics/resolve.ts,
 * which re-exports these. Its own module, with no imports, so code that only
 * needs to recognise the key (snapshotAccess.ts) doesn't load metric
 * resolution — and Community code can recognise it without lib/metrics.
 */

/** Reserved queryId prefix that marks a block as metric-backed. */
export const METRIC_QUERY_PREFIX = "metric:";

export function metricQueryId(slug: string): string {
  return METRIC_QUERY_PREFIX + slug;
}

/** Reverse of metricQueryId() — null when queryId isn't metric-backed. */
export function metricSlugFromQueryId(queryId: string | undefined | null): string | null {
  if (!queryId || !queryId.startsWith(METRIC_QUERY_PREFIX)) return null;
  return queryId.slice(METRIC_QUERY_PREFIX.length);
}
