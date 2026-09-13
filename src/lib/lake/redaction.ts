/**
 * Column-level redaction (Phase 3).
 *
 * The lake table's catalog row carries sensitivity tags + per-tag role
 * allowlists. When the runner returns rows for a viewer, this module
 * walks each row and replaces sensitive cells with a redaction marker
 * if the viewer's roles don't include any allowed role.
 *
 * Tenant admins always see unredacted values — the threat model here
 * is "share a dashboard with a marketing teammate without leaking the
 * customer email column", not "hide data from the workspace owner".
 *
 * Replacement strategy:
 *   - "pii" / "secret" → "•••••" (5 bullets — visually distinct, survives copy/paste)
 *   - "financial" / "health" → "<redacted>" so the empty space is obvious
 * Both choices keep the value short so chart / table layouts don't reflow.
 */
import type { LakeColumn } from "./tables";

export type RedactionViewer = {
  id: string;
  role: string;          // 'admin' | 'editor' | 'viewer' (raw user role)
  roleSlugs: string[];   // role slugs from RBAC
};

export function redactionMaskFor(sensitivity: NonNullable<LakeColumn["sensitivity"]>): string {
  if (sensitivity === "pii" || sensitivity === "secret") return "•••••";
  return "<redacted>";
}

/**
 * Decide whether to redact `column` for `viewer`. Pure — caller passes
 * the resolved schema column (including sensitivity + unredactedForRoles)
 * and the viewer's role slugs.
 */
export function shouldRedact(viewer: RedactionViewer, column: LakeColumn): boolean {
  if (!column.sensitivity) return false;
  // Tenant admin bypass — they own the data and need to see it for
  // troubleshooting. Documented in the column-level redaction roadmap
  // section so security reviewers know.
  if (viewer.role === "admin") return false;
  const allowed = column.unredactedForRoles ?? [];
  // Empty allowlist = no role can see it. That's the "default deny"
  // posture — opt-in to visibility per role.
  if (allowed.length === 0) return true;
  for (const r of allowed) {
    if (viewer.roleSlugs.includes(r)) return false;
  }
  return true;
}

/**
 * Apply redaction to a result-set in place. Mutates rows[] for speed
 * (we own the array — it's never returned to the runner cache). Returns
 * the same array for chainability.
 *
 * Performance: O(rows × redactedColumns). For a 500-row result set with
 * 1-2 redacted columns, this is well under a millisecond.
 */
export function applyRedaction(
  rows: Array<Record<string, unknown>>,
  schema: LakeColumn[],
  viewer: RedactionViewer,
): Array<Record<string, unknown>> {
  const redactCols = schema.filter((c) => shouldRedact(viewer, c));
  if (redactCols.length === 0) return rows;
  const masks = new Map<string, string>();
  for (const c of redactCols) masks.set(c.name, redactionMaskFor(c.sensitivity!));
  for (const row of rows) {
    for (const [name, mask] of masks) {
      if (name in row && row[name] != null && row[name] !== "") {
        row[name] = mask;
      }
    }
  }
  return rows;
}

/**
 * Quick read-allowed check for "is there any sensitive column on this
 * table that this viewer cannot see?" — used by the API to record an
 * audit row when sensitive data is read.
 */
export function readsSensitiveData(viewer: RedactionViewer, schema: LakeColumn[]): {
  any: boolean;
  redactedColumns: string[];
} {
  const redactedColumns = schema.filter((c) => shouldRedact(viewer, c)).map((c) => c.name);
  return { any: redactedColumns.length > 0, redactedColumns };
}
