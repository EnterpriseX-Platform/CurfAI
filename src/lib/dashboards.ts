/**
 * Shared Dashboard helpers used by both /api/dashboards route files.
 *
 * Lives here rather than being exported from src/app/api/dashboards/route.ts
 * because a Next.js App Router route.ts file may only export the framework's
 * expected names (GET/POST/etc.) — any other named export fails
 * `tsc --noEmit` against the generated `.next/types/.../route.ts` d.ts shim
 * (same constraint payload.ts's docstring documents for page.tsx files).
 */
import { prisma } from "@/lib/db";

/**
 * Convert a name into a URL-safe slug. Lowercase, dash-separated, ASCII-only.
 * Falls back to "dashboard" if the input has no slug-able characters at all
 * (e.g. all emoji); the caller's uniqueness loop then appends "-2", "-3"…
 */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return base || "dashboard";
}

/** Ensure (tenantId, slug) is unique by suffixing -2, -3, … if needed. */
export async function pickUniqueSlug(tenantId: string, base: string): Promise<string> {
  let candidate = base;
  let n = 2;
  while (await prisma.dashboard.findUnique({ where: { tenantId_slug: { tenantId, slug: candidate } } })) {
    candidate = `${base}-${n++}`;
    if (n > 200) throw new Error("Could not find a unique dashboard slug");
  }
  return candidate;
}

/**
 * Heuristic 0-100 "health" score for the Interactive Dashboard hub grid.
 * Dashboard has no domain KPI (Revenue/NPS/etc.) to show per-card, and
 * fabricating one would violate the no-fabricated-data rule — so this
 * scores what's actually observable: how recently the dashboard was
 * touched, and how many reports are wired into it. Weighted 70/30
 * freshness/coverage so a dashboard nobody's updated in months drops fast
 * even with a full report count. Not persisted — recomputed on every list.
 */
export function computeDashboardHealth(updatedAt: Date, reportCount: number): number {
  const ageHours = Math.max(0, (Date.now() - updatedAt.getTime()) / 36e5);
  const freshness = ageHours <= 24 ? 100 : Math.max(10, 100 - (ageHours - 24) / 12);
  const coverage = Math.min(100, 40 + reportCount * 20);
  return Math.round(freshness * 0.7 + coverage * 0.3);
}
