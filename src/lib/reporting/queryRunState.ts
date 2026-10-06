/**
 * What a query's provenance record lets a UI claim. The runner reports a query
 * that failed — or that the viewer isn't allowed to see — as an EMPTY result with
 * the reason on the record, so "ran", "failed" and "restricted" all look like
 * "no rows" unless something reads the record. A record that is missing means
 * nothing was said about this query, which is not a failure.
 *
 * Its own module, and type-only imports: this is used by client components and
 * by BlockEmptyState (no "use client"), and provenance.ts pulls in node:crypto
 * for its hashing, which a browser bundle can't include.
 */
import type { ProvenanceMap, ProvenanceRecord } from "./provenance";

export type QueryRunState =
  | { kind: "ran" }
  | { kind: "failed"; reason: string }
  | { kind: "restricted"; reason: string };

export function queryRunState(record: ProvenanceRecord | undefined): QueryRunState {
  if (record?.executionError) return { kind: "failed", reason: record.executionError };
  if (record?.accessDeniedNote) return { kind: "restricted", reason: record.accessDeniedNote };
  return { kind: "ran" };
}

export type QueryNotRun = Exclude<QueryRunState, { kind: "ran" }>;

/** queryRunState, narrowed: undefined when the query ran. */
export function queryNotRun(record: ProvenanceRecord | undefined): QueryNotRun | undefined {
  const s = queryRunState(record);
  return s.kind === "ran" ? undefined : s;
}

/**
 * { queryId: reason } for every query that did not run — the caller-facing form of
 * "this empty array is a failure, not a result". A public API that returns a dataset
 * with no provenance otherwise hands a script HTTP 200 and [] with no way to tell.
 */
export function queryErrors(provenance: ProvenanceMap | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, rec] of Object.entries(provenance ?? {})) {
    const notRun = queryNotRun(rec);
    if (notRun) out[id] = notRun.reason;
  }
  return out;
}

/**
 * How to record a run whose dataset is being stored as a snapshot.
 *
 * Every consumer that looks for a baseline — KPI history, the Brief's period
 * comparison, causal analysis, watchers — reads runs with status "completed", and
 * the History page only offers replay for those. A load in which a query failed (or
 * was hidden from this viewer) stores an EMPTY array for it; recorded as
 * "completed" that becomes the day's latest snapshot (the KPI history keeps one
 * point per day — the latest run) and erases the good point, or becomes the "previous"
 * value the next run compares against. Recorded as failed/restricted it is still on
 * the History page, with the reason, but no longer a baseline.
 *
 * `withheld` counts the queries that didn't run at all because only blocks
 * hidden from this viewer used them (see visibleReport()). They have no
 * provenance entry, and the snapshot has no rows for them, so such a run is
 * restricted too.
 */
export function runOutcome(provenance: ProvenanceMap | undefined, withheld = 0): { status: "completed" | "failed" | "restricted"; error?: string } {
  const entries = Object.entries(provenance ?? {});
  const total = entries.length + withheld;
  const states = entries.map(([id, rec]) => ({ id, state: queryNotRun(rec) }));
  const failed = states.filter((s) => s.state?.kind === "failed");
  if (failed.length > 0) {
    return { status: "failed", error: `${failed.length} of ${total} queries didn't run: ${failed[0].state!.reason}`.slice(0, 500) };
  }
  const restricted = states.filter((s) => s.state?.kind === "restricted").length + withheld;
  if (restricted > 0) {
    return { status: "restricted", error: `${restricted} of ${total} queries were hidden from this viewer` };
  }
  return { status: "completed" };
}
