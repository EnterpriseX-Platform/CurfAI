/**
 * Shared OnScreenDisplay helpers used by /api/on-screen route files.
 *
 * Lives here rather than being exported from a route.ts file because a
 * Next.js App Router route.ts file may only export the framework's expected
 * names (GET/POST/etc.) — any other named export fails `tsc --noEmit`
 * against the generated `.next/types/.../route.ts` d.ts shim (see
 * lib/dashboards.ts, which documents the same constraint for Dashboard).
 */
import { prisma } from "@/lib/db";
import { slugify } from "@/lib/dashboards";

export { slugify };

/** Ensure (tenantId, slug) is unique by suffixing -2, -3, … if needed. */
export async function pickUniqueOnScreenSlug(tenantId: string, base: string): Promise<string> {
  let candidate = base;
  let n = 2;
  while (await prisma.onScreenDisplay.findUnique({ where: { tenantId_slug: { tenantId, slug: candidate } } })) {
    candidate = `${base}-${n++}`;
    if (n > 200) throw new Error("Could not find a unique on-screen display slug");
  }
  return candidate;
}
