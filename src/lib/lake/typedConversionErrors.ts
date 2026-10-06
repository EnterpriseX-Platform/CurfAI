/**
 * Errors an existing-table typed conversion can raise, kept in one small
 * dependency-free file so the Community-shipped route can recognise them
 * without importing anything paid (typedConversionGuard.ts, which throws the
 * first one, is excluded from the Community export).
 *
 * Both have a duck-typed guard alongside the class. Prefer the guard to
 * `instanceof` at a call site: the classes are reached through more than one
 * import specifier, and a loader that instantiates a module per specifier
 * (tsx does; Next's HMR can) gives each its own class object — `instanceof`
 * can then be false for an error that really is this one.
 */

export type TypedConversionBlockReason = "branch_open" | "conversion_in_progress";

/** Refused by the branch/conversion guard (E1B_PHASE_D_SCOPING_PLAN.md D3).
 *  `reason` lets a route map it to a specific 409 without string-matching. */
export class TypedConversionBlockedError extends Error {
  readonly reason: TypedConversionBlockReason;
  constructor(reason: TypedConversionBlockReason, message: string) {
    super(message);
    this.name = "TypedConversionBlockedError";
    this.reason = reason;
  }
}

export function isTypedConversionBlockedError(e: unknown): e is TypedConversionBlockedError {
  return e instanceof Error && e.name === "TypedConversionBlockedError" && "reason" in e;
}

/**
 * Thrown when a conversion would lose a different number of cells than the
 * caller said its admin confirmed — the data changed between the preview
 * they were shown and the moment of the rebuild. Nothing has been changed
 * when this is thrown (it fires inside the rebuild's transaction, before the
 * original table is dropped). `expected`/`actual` are per-column lossy-cell
 * counts so a route can show what moved.
 */
export class TypedConversionDriftError extends Error {
  readonly expected: Record<string, number>;
  readonly actual: Record<string, number>;
  constructor(expected: Record<string, number>, actual: Record<string, number>) {
    super(
      "The table's data changed since the preview you confirmed, so nothing was converted. " +
      "Review the new preview and confirm again.",
    );
    this.name = "TypedConversionDriftError";
    this.expected = expected;
    this.actual = actual;
  }
}

export function isTypedConversionDriftError(e: unknown): e is TypedConversionDriftError {
  return e instanceof Error && e.name === "TypedConversionDriftError" && "expected" in e && "actual" in e;
}
