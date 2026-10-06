/**
 * Run a report and return ONE query's rows — throwing if that query didn't
 * actually run.
 *
 * runReport() isolates per-query failures on purpose: one broken block
 * shouldn't blank the rest of a page, so a query that throws (driver error,
 * network failure, a column that no longer exists, an API outage) comes back as
 * an empty array with the reason parked in provenance.executionError. That's
 * right for anything that DISPLAYS the result. It is wrong for anything that
 * WRITES it somewhere, because "the query failed" and "the query returned
 * nothing" look identical to the writer — and replacing a table with nothing
 * looks like success. A materialized view, a pipeline step and a REST pull each
 * used to do exactly that: the refresh after a broken query, or the pull during
 * an upstream outage, replaced a good table with an empty one and reported ok.
 *
 * Use this from any code path that persists what a report query returns.
 */
import { runReportWithProof, type RunContext } from "./runner";
import type { ProvenanceMap } from "./provenance";
import { queryNotRun } from "./queryRunState";

/**
 * Why a query did NOT run — the runner's caught error or its access note — or
 * undefined when it ran (whatever it returned, including nothing). For code
 * that decides something from a result and has to tell "failed" from "empty".
 */
export function queryNotRunReason(provenance: ProvenanceMap, queryId: string): string | undefined {
  return queryNotRun(provenance[queryId])?.reason;
}

export async function runQueryStrict(ctx: RunContext, queryId: string): Promise<any[]> {
  const { dataset, provenance } = await runReportWithProof(ctx);
  const notRun = queryNotRunReason(provenance, queryId);
  if (notRun) throw new Error(notRun);
  const rows = dataset[queryId];
  if (rows === undefined) throw new Error(`Query "${queryId}" produced no result`);
  return rows;
}
