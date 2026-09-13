/**
 * In-runner hash join engine. Tier 2 cross-source JOIN — when the runner
 * needs to merge rows from two heterogeneous data sources (Postgres + REST,
 * Postgres + Excel, etc.) it can't use SQLite ATTACH (Tier 1, file-backed
 * only). Instead it runs each source independently and joins the row sets
 * here.
 *
 * Pure JS, no native deps — fits any sandbox. Hash strategy: Map keyed on
 * the right side's join column, then a single pass over the left side.
 * Memory bound is right.length entries in the hash map; the join itself
 * streams the left side, so left can be arbitrarily large in principle —
 * we cap merged-row output to MAX_MERGED_ROWS to keep Node memory sane.
 *
 * Key comparison uses String(value) — null-safe, mixes numeric and string
 * keys consistently. Pure JS Map keys would otherwise have == surprises
 * (1 vs "1"). Production note: revisit if a customer needs case-sensitive
 * or schema-aware key comparison.
 */
import type { Row } from "@/lib/reporting/interpolate";

export const MAX_MERGED_ROWS = 100_000;

export type JoinSpec = {
  type: "left" | "inner";
  /** Column name on the LEFT (primary) side. */
  leftKey: string;
  /** Column name on the RIGHT (joined) side. */
  rightKey: string;
  /** Prefix for right-side columns in the output: `<alias>__<column>`. */
  alias: string;
};

export type HashJoinResult = {
  rows: Row[];
  /** Number of left rows that found a match. Useful for "drop rate" provenance. */
  matched: number;
  /** Number of left rows that didn't match (left-join only — they're still emitted). */
  unmatched: number;
  /** True if we hit MAX_MERGED_ROWS and stopped. */
  truncated: boolean;
};

/**
 * Stable string form of a join-key value. null/undefined stay distinct from
 * the empty string; numbers and strings compare cleanly via String() coercion.
 */
function keyOf(v: unknown): string | null {
  if (v == null) return null;
  return String(v);
}

/** Prefix every key in `row` with `<alias>__`. Returns a new object. */
function prefix(row: Row, alias: string): Row {
  const out: Row = {};
  for (const k of Object.keys(row)) out[`${alias}__${k}`] = row[k];
  return out;
}

export function hashJoin(left: Row[], right: Row[], spec: JoinSpec): HashJoinResult {
  // Build the right-side hash. One key may correspond to many right rows
  // (e.g. duplicate region matches), so we store an array per key. SQL JOIN
  // semantics: each match emits one combined row per right match.
  const buckets = new Map<string, Row[]>();
  for (const r of right) {
    const k = keyOf(r[spec.rightKey]);
    if (k == null) continue; // null on the right side never matches
    let arr = buckets.get(k);
    if (!arr) { arr = []; buckets.set(k, arr); }
    arr.push(r);
  }

  const out: Row[] = [];
  let matched = 0;
  let unmatched = 0;
  let truncated = false;

  for (const l of left) {
    if (out.length >= MAX_MERGED_ROWS) { truncated = true; break; }
    const lk = keyOf(l[spec.leftKey]);
    const matches = lk != null ? buckets.get(lk) : undefined;
    if (matches && matches.length > 0) {
      matched++;
      for (const r of matches) {
        if (out.length >= MAX_MERGED_ROWS) { truncated = true; break; }
        out.push({ ...l, ...prefix(r, spec.alias) });
      }
    } else {
      unmatched++;
      if (spec.type === "left") {
        // Left join: emit the left row with nulls for every right column we
        // would have introduced. Column names are unknown without a sample
        // (right side may have been empty), so we leave them missing — the
        // table block renders blank cells either way.
        out.push({ ...l });
      }
      // Inner join: drop the left row.
    }
  }

  return { rows: out, matched, unmatched, truncated };
}
