import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { AttributeError, engineEndpoints, listMemberAttributes, pushPairs, replaceAttribute } from "@/lib/engine/attributes";

export const dynamic = "force-dynamic";

/**
 * What each member of the workspace holds for the engine's row rules (an agency code, a region…). Curf is the
 * source of truth; a change here is written through to every engine the workspace uses. Admins only.
 */
export async function GET(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const [{ members, names }, endpoints] = await Promise.all([listMemberAttributes(user.tenantId), engineEndpoints(user.tenantId)]);
  return NextResponse.json({
    members, names,
    // Where changes are sent. The URL itself is not needed on the screen.
    engines: endpoints.map((e) => ({ dataSourceId: e.dataSourceId, name: e.name, source: e.target.source })),
  });
}

const Body = z.object({
  userId: z.string().min(1).max(100),
  name: z.string().max(100),
  values: z.array(z.union([z.string(), z.number()])).max(5000),
});

export async function PUT(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "userId, name and values are required." }, { status: 400 });

  try {
    const saved = await replaceAttribute(user.tenantId, parsed.data.userId, parsed.data.name, parsed.data.values);
    // Counts only: the values are who may see which rows, which the audit trail need not repeat.
    recordAudit({ user, kind: "engine.attribute.set", target: parsed.data.userId, req, meta: { name: saved.name, values: saved.values.length } });
    const sync = await pushPairs(user.tenantId, { id: user.id, isAdmin: true, roles: [] }, [{ userId: parsed.data.userId, name: saved.name }]);
    return NextResponse.json({ saved, sync });
  } catch (e: any) {
    if (e instanceof AttributeError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
