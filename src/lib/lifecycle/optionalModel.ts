/**
 * A Prisma model that exists in the paid edition's schema but not in the Community one (the export prunes models along
 * with the features that use them — scripts/community-export/manifest.json, schemaExcludeModels).
 *
 * The customer lifecycle ships in both editions, and its job is to leave nothing behind, so where it touches such a
 * model it must cope with the model being absent: `optionalModel("orgPerson")` is the delegate, or null in an edition
 * without it. Typed as any on purpose — the shared code is compiled against the pruned client, which has no such type.
 */
import { prisma } from "@/lib/db";

export function optionalModel(delegateName: string): any | null {
  const d = (prisma as any)[delegateName];
  return d && typeof d.findMany === "function" ? d : null;
}

/** `fn` run against the model, or `fallback` when this edition has none. */
export async function withModel<T>(delegateName: string, fn: (m: any) => Promise<T>, fallback: T): Promise<T> {
  const m = optionalModel(delegateName);
  return m ? fn(m) : fallback;
}
