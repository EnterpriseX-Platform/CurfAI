/**
 * Diff utilities for comparing two ReportRun dataset snapshots.
 *
 * Given two datasets (each { queryId: Row[] }), we produce a DiffReport
 * summarising every cell-level change between them. The UI renders the
 * shape; this file is purely a pure-function reducer so it can also be
 * run from scripts, tests, or an LLM caller.
 */

import type { Dataset, Row } from "@/lib/reporting/interpolate";

/** One field change inside a row — `key: 12 → 15`. */
export type FieldChange = {
  key: string;
  before: unknown;
  after: unknown;
  /** For numeric values, the signed percentage change (1.23 = +123%). null otherwise. */
  pct: number | null;
};

/** Row-level classification. */
export type RowDiff =
  | { kind: "added";     id: string; row: Row }
  | { kind: "removed";   id: string; row: Row }
  | { kind: "changed";   id: string; before: Row; after: Row; changes: FieldChange[] }
  | { kind: "unchanged"; id: string; row: Row };

/** All changes for one queryId. */
export type QueryDiff = {
  queryId: string;
  shape: "scalar" | "rows";
  /** For "scalar" (single-row) queries: the field-level changes in that row. */
  scalarChanges?: FieldChange[];
  /** For "rows" (multi-row) queries: per-row classification. */
  rowDiffs?: RowDiff[];
  /** Counts for quick summary display. */
  counts: {
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
  };
};

export type DiffReport = {
  queries: QueryDiff[];
  /** Grand totals across all queries, useful for banner-style summaries. */
  totals: { added: number; removed: number; changed: number };
};

/**
 * Best-effort stable row identity. Tries common PK-ish field names, falls back
 * to a JSON-stringified concatenation of the whole row (identical rows match).
 */
function rowIdentity(row: Row): string {
  const preferred = ["id", "sku", "product", "name", "month", "line", "department", "branch", "email"];
  for (const k of preferred) {
    if (k in row && row[k] != null) return `${k}=${String(row[k])}`;
  }
  // Fallback — whole-row JSON. Two rows with identical content get the same
  // identity, which is correct for our purposes (nothing changed).
  return JSON.stringify(row);
}

function numericPct(before: unknown, after: unknown): number | null {
  const b = typeof before === "number" ? before : Number(before);
  const a = typeof after === "number" ? after : Number(after);
  if (!Number.isFinite(b) || !Number.isFinite(a)) return null;
  if (b === 0) return a === 0 ? 0 : null; // avoid Infinity
  return (a - b) / Math.abs(b);
}

function diffRow(before: Row, after: Row): FieldChange[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes: FieldChange[] = [];
  for (const k of keys) {
    const b = before[k];
    const a = after[k];
    if (Object.is(b, a)) continue;
    // Treat equal-by-stringification as unchanged too (covers stringified numbers).
    if (b != null && a != null && String(b) === String(a)) continue;
    changes.push({ key: k, before: b, after: a, pct: numericPct(b, a) });
  }
  return changes;
}

/** Diff a single query's rows. */
function diffQueryRows(queryId: string, before: Row[], after: Row[]): QueryDiff {
  // If both sides are a single row, treat as a scalar KPI-ish query - every
  // field change is surfaced directly without row-identity bookkeeping.
  if (before.length === 1 && after.length === 1) {
    const scalarChanges = diffRow(before[0], after[0]);
    return {
      queryId,
      shape: "scalar",
      scalarChanges,
      counts: {
        added: 0,
        removed: 0,
        changed: scalarChanges.length > 0 ? 1 : 0,
        unchanged: scalarChanges.length > 0 ? 0 : 1,
      },
    };
  }

  const beforeById = new Map<string, Row>();
  for (const r of before) beforeById.set(rowIdentity(r), r);
  const afterById = new Map<string, Row>();
  for (const r of after) afterById.set(rowIdentity(r), r);

  const rowDiffs: RowDiff[] = [];
  const seen = new Set<string>();
  let added = 0, removed = 0, changed = 0, unchanged = 0;

  for (const [id, row] of afterById) {
    seen.add(id);
    const prior = beforeById.get(id);
    if (!prior) {
      rowDiffs.push({ kind: "added", id, row });
      added++;
      continue;
    }
    const fieldChanges = diffRow(prior, row);
    if (fieldChanges.length === 0) {
      rowDiffs.push({ kind: "unchanged", id, row });
      unchanged++;
    } else {
      rowDiffs.push({ kind: "changed", id, before: prior, after: row, changes: fieldChanges });
      changed++;
    }
  }
  for (const [id, row] of beforeById) {
    if (seen.has(id)) continue;
    rowDiffs.push({ kind: "removed", id, row });
    removed++;
  }

  return {
    queryId,
    shape: "rows",
    rowDiffs,
    counts: { added, removed, changed, unchanged },
  };
}

export function diffDatasets(before: Dataset, after: Dataset): DiffReport {
  const queryIds = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
  const queries: QueryDiff[] = [];
  let tAdded = 0, tRemoved = 0, tChanged = 0;
  for (const qid of queryIds) {
    const q = diffQueryRows(qid, before[qid] ?? [], after[qid] ?? []);
    queries.push(q);
    tAdded += q.counts.added;
    tRemoved += q.counts.removed;
    tChanged += q.counts.changed + (q.shape === "scalar" && q.scalarChanges && q.scalarChanges.length > 0 ? 0 : 0);
  }
  // Scalar changes count once each per query - include them in the grand total.
  for (const q of queries) {
    if (q.shape === "scalar" && q.scalarChanges && q.scalarChanges.length > 0) tChanged += 1;
  }
  return { queries, totals: { added: tAdded, removed: tRemoved, changed: tChanged } };
}
