/**
 * PUT /api/catalog/metadata — curate one catalog entry.
 *
 * Body: { kind, id, description?, domain?, tags?, isCurated? }
 *
 * Catalog metadata lives on the entity rows themselves (LakeTable,
 * MaterializedView, Report each carry description/domain/tagsJson/isCurated)
 * rather than in a side table, so this writes through to whichever model the
 * `kind` names — always scoped by tenantId.
 *
 * Why this is NOT /api/v1/catalog/metadata, which is what the Catalog page
 * used to call: /api/v1 is read-only by policy (see CLAUDE.md — the policy
 * names catalog metadata explicitly), so the write belongs on the internal
 * surface. The v1 route never existed, which is why every Save on the
 * Catalog page returned "HTTP 404" and no description, domain, tag or
 * curated flag could be saved at all.
 *
 * `isCurated` is gated on catalog.curate (Growth). The flag has been in
 * FEATURE_TIERS since the feature shipped with nothing enforcing it; the
 * editable fields below stay open to every tier, as they were.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { featureGate } from "@/lib/featureGate";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Only kinds whose rows actually carry the metadata columns. */
const KIND = z.enum(["lake_table", "mv", "report"]);

const Body = z.object({
  kind: KIND,
  id: z.string().min(1),
  description: z.string().max(2000).nullable().optional(),
  domain: z.string().max(80).nullable().optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  isCurated: z.boolean().optional(),
});

export async function PUT(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Curating is an authoring action; viewers read the catalog, they don't
  // shape it. Mirrors the role check the Catalog page already makes when it
  // decides whether to show the curated checkbox.
  if (user.role === "viewer" || user.role === "executive") {
    return NextResponse.json({ error: "Editor or admin required" }, { status: 403 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });
  }
  const { kind, id, description, domain, tags, isCurated } = parsed.data;

  if (isCurated !== undefined) {
    const block = await featureGate(user, "catalog.curate");
    if (block) return block;
  }

  const data: Record<string, unknown> = {};
  if (description !== undefined) data.description = description?.trim() || null;
  if (domain !== undefined) data.domain = domain?.trim() || null;
  if (tags !== undefined) {
    // Normalised the same way the facet picker compares them, so "Finance"
    // and "finance" don't split one domain into two rows in the sidebar.
    const clean = Array.from(new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean)));
    data.tagsJson = JSON.stringify(clean);
  }
  if (isCurated !== undefined) data.isCurated = isCurated;
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  // updateMany, not update: it takes tenantId in the WHERE, so a foreign id
  // matches zero rows instead of throwing — and can never write across
  // tenants even if the id is guessed.
  const where = { id, tenantId: user.tenantId };
  let updated: { count: number };
  try {
    updated =
      kind === "lake_table" ? await prisma.lakeTable.updateMany({ where, data })
      : kind === "mv"       ? await prisma.materializedView.updateMany({ where, data })
      :                       await prisma.report.updateMany({ where, data });
  } catch (e: any) {
    return NextResponse.json(
      { error: "Could not save catalog metadata", detail: e?.message?.slice(0, 200) ?? null },
      { status: 500 },
    );
  }
  if (updated.count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  recordAudit({
    user, kind: "catalog.curate", target: id, req,
    meta: { catalogKind: kind, fields: Object.keys(data) },
  });

  return NextResponse.json({ ok: true });
}
