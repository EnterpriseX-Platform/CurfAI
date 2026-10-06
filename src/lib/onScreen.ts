/**
 * Shared OnScreenDisplay helpers used by /api/on-screen route files and
 * scripts that set displays up.
 *
 * Lives here rather than being exported from a route.ts file because a
 * Next.js App Router route.ts file may only export the framework's expected
 * names (GET/POST/etc.) — any other named export fails `tsc --noEmit`
 * against the generated `.next/types/.../route.ts` d.ts shim (see
 * lib/dashboards.ts, which documents the same constraint for Dashboard).
 */
import { prisma } from "@/lib/db";
import { slugify } from "@/lib/dashboards";
import { writeVisibility, type Visibility } from "@/lib/datasourceAcl";

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

export type OnScreenLayout = "carousel" | "table_only" | "table_chart" | "chart_only";

/**
 * Create an On Screen display from reports in one workspace: ordered as
 * given, any id not in the workspace dropped. Null when none of them are.
 * POST /api/on-screen and scripts/master-builder/apply-plan.ts both create
 * through here.
 */
export async function createOnScreenDisplay(args: {
  tenantId: string;
  createdById: string;
  name: string;
  slug?: string;
  reportIds: string[];
  rotationSeconds: number;
  theme: "light" | "dark";
  layout: OnScreenLayout;
  visibility: Visibility;
}): Promise<{ id: string; name: string; slug: string; reportCount: number; dropped: number } | null> {
  const rows = await prisma.report.findMany({ where: { id: { in: args.reportIds }, tenantId: args.tenantId }, select: { id: true } });
  const valid = new Set(rows.map((r) => r.id));
  const orderedIds = args.reportIds.filter((id) => valid.has(id));
  if (orderedIds.length === 0) return null;
  const slug = await pickUniqueOnScreenSlug(args.tenantId, args.slug ?? slugify(args.name));
  const acl = writeVisibility(args.visibility);
  const created = await prisma.onScreenDisplay.create({
    data: {
      tenantId: args.tenantId,
      name: args.name,
      slug,
      reportIdsJson: JSON.stringify(orderedIds),
      rotationSeconds: args.rotationSeconds,
      theme: args.theme,
      layout: args.layout,
      visibleToRolesJson: acl.visibleToRolesJson,
      ownerUserId: acl.ownerUserId,
      createdById: args.createdById,
    },
  });
  return { id: created.id, name: created.name, slug: created.slug, reportCount: orderedIds.length, dropped: args.reportIds.length - orderedIds.length };
}
