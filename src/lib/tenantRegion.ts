/**
 * Self-declared tenant jurisdiction — mirrors lib/reporting/currency.ts's
 * shape (curated picker list + a validity check).
 *
 * This is metadata a tenant declares about themselves, NOT a data-residency
 * guarantee — Curf's deployment stays single-region regardless of this
 * value (see /admin/compliance's "residency" gap item and
 * ROADMAP-DATA-LAYER.md's Phase 3). It exists so the PDPA processing record
 * panel (admin/tenant/PdpaRecordPanel.tsx) can show Thailand-specific
 * guidance when relevant and a generic note otherwise.
 */

export const REGION_OPTIONS: Array<{ code: string; label: string }> = [
  { code: "th", label: "Thailand" },
  { code: "sea", label: "Southeast Asia" },
  { code: "eu", label: "European Union" },
  { code: "us", label: "United States" },
  { code: "global", label: "Global / Unspecified" },
];

const VALID_CODES = new Set(REGION_OPTIONS.map((r) => r.code));
export function isKnownRegionCode(code: string): boolean {
  return VALID_CODES.has(code.toLowerCase());
}
