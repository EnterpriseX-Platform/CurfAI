import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { replaceAttribute, pushPairs, AttributeError } from "@/lib/engine/attributes";
import { groupImport } from "@/lib/engine/attributeModel";

export const dynamic = "force-dynamic";

const MAX_ROWS = 5000;
const Body = z.object({
  rows: z.array(z.object({ email: z.string().max(320), name: z.string().max(100), value: z.union([z.string(), z.number()]) })).min(1).max(MAX_ROWS),
});

/**
 * Sets attributes for many people at once from "email, attribute, value" lines (a spreadsheet the customer already
 * has). All or nothing as to who: if any email is not a member of this workspace, nothing is changed and the
 * list of unknown emails comes back, so a typo cannot quietly leave someone without access. Each person's values
 * for each attribute named in the file are REPLACED by the ones in the file.
 */
export async function POST(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: `Send between 1 and ${MAX_ROWS} rows of { email, name, value }.` }, { status: 400 });

  const grouped = groupImport(parsed.data.rows.map((r) => ({ email: r.email, name: r.name, value: String(r.value) })));
  if (!grouped.ok) return NextResponse.json({ error: grouped.error, row: grouped.row || undefined }, { status: 422 });

  const emails = [...new Set(grouped.sets.map((s) => s.email))];
  const members = await prisma.membership.findMany({
    where: { tenantId: user.tenantId, user: { email: { in: emails, mode: "insensitive" } } },
    select: { user: { select: { id: true, email: true } } },
  });
  const idByEmail = new Map(members.map((m) => [m.user.email.toLowerCase(), m.user.id]));
  const unknown = emails.filter((e) => !idByEmail.has(e));
  if (unknown.length) {
    return NextResponse.json({ error: "Some people are not members of this workspace, so nothing was changed.", unknown: unknown.slice(0, 50), unknownCount: unknown.length }, { status: 422 });
  }

  try {
    const pairs: Array<{ userId: string; name: string }> = [];
    for (const set of grouped.sets) {
      const userId = idByEmail.get(set.email)!;
      await replaceAttribute(user.tenantId, userId, set.name, set.values);
      pairs.push({ userId, name: set.name });
    }
    recordAudit({ user, kind: "engine.attribute.import", target: user.tenantId, req, meta: { people: emails.length, sets: pairs.length } });
    const sync = await pushPairs(user.tenantId, { id: user.id, isAdmin: true, roles: [] }, pairs);
    return NextResponse.json({ people: emails.length, sets: pairs.length, sync });
  } catch (e: any) {
    if (e instanceof AttributeError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
