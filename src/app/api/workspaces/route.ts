/**
 * POST /api/workspaces — create an additional workspace for the SIGNED-IN user.
 *
 * One global User row per email (see loadMembershipsForEmail in lib/auth.ts) —
 * adding a workspace is just a new Membership(userId, tenantId, role: admin)
 * for the caller's existing identity. No new credential, nothing to keep in
 * sync: the same account, same passwordHash, now with one more workspace in
 * the switcher.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { provisionStarterPack } from "@/lib/tenant/provision";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  name: z.string().min(1).max(80),
  /** Skip the demo content when the caller is bringing their own data. */
  starterPack: z.boolean().optional().default(true),
});

function slugify(s: string): string {
  const base = s
    .toLowerCase()
    .trim()
    // Keep unicode letters/digits so non-Latin names (e.g. Thai) don't collapse
    // to an empty slug; only punctuation and whitespace become hyphens. \p{M}
    // (combining marks) must stay too — Thai tone marks and vowel signs like
    // ั ่ ้ ์ are category Mark, not Letter, so without this a word like
    // "ตัวอย่าง" gets its marks stripped and splits mid-syllable ("ต-วอย-าง").
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "workspace";
}

async function resolveUniqueSlug(base: string): Promise<string> {
  let candidate = base;
  for (let i = 2; i < 100; i++) {
    const taken = await prisma.tenant.findUnique({ where: { slug: candidate } });
    if (!taken) return candidate;
    candidate = `${base}-${i}`;
  }
  return `${base}-${randomBytes(3).toString("hex")}`;
}

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // API keys authenticate as a tenant, not a person — creating tenants is an
  // interactive action tied to a real account.
  if ((user as any).viaApiKey) {
    return NextResponse.json({ error: "Session required to create a workspace" }, { status: 403 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Workspace name is required", issues: parsed.error.issues }, { status: 400 });
  }

  const me = await prisma.user.findUnique({
    where: { id: user.id },
    select: { email: true },
  });
  if (!me?.email) return NextResponse.json({ error: "Account not found" }, { status: 404 });

  // New workspace joins the creator's EXISTING organization (the one that
  // owns whichever tenant is active in their session right now) — never a
  // new org of its own. A person can hold Platform Admin in several orgs,
  // so "the active tenant's org" is the only unambiguous choice here.
  const activeTenant = await prisma.tenant.findUnique({
    where: { id: user.tenantId },
    select: { organizationId: true },
  });

  const slug = await resolveUniqueSlug(slugify(parsed.data.name));

  try {
    const tenant = await prisma.tenant.create({
      data: {
        slug,
        name: parsed.data.name.trim(),
        webhookSigningSecret: randomBytes(32).toString("hex"),
        organizationId: activeTenant?.organizationId ?? undefined,
      },
    });
    const member = await prisma.membership.create({
      data: { userId: user.id, tenantId: tenant.id, role: "admin" },
    });

    // Same default role set the signup flow installs.
    for (const r of [
      { slug: "analyst",      label: "Analyst",      description: "Full detail." },
      { slug: "new_hire",     label: "New hire",     description: "Simplified view." },
      { slug: "finance_lead", label: "Finance lead", description: "Financial KPIs + audit detail." },
    ]) {
      await prisma.role.create({
        data: { tenantId: tenant.id, slug: r.slug, label: r.label, description: r.description },
      }).catch(() => null);
    }

    let provisioned: { reportsCreated: number; dataSourcesCreated: number } = {
      reportsCreated: 0, dataSourcesCreated: 0,
    };
    if (parsed.data.starterPack) {
      try {
        const r = await provisionStarterPack(tenant.id);
        provisioned = { reportsCreated: r.reportsCreated, dataSourcesCreated: r.dataSourcesCreated };
      } catch (e: any) {
        // Demo content is a nicety — never fail workspace creation over it.
        console.warn("[workspaces] starter pack failed:", e?.message ?? e);
      }
    }

    recordAudit({
      tenantId: tenant.id,
      userId: user.id,
      userEmail: me.email,
      kind: "tenant.create",
      target: tenant.id,
      req,
      meta: { workspaceName: tenant.name, slug: tenant.slug, via: "in-app" },
    });

    return NextResponse.json({
      ok: true,
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
      membership: { tenantId: tenant.id, userId: user.id, role: member.role },
      provisioned,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Could not create workspace" }, { status: 500 });
  }
}
