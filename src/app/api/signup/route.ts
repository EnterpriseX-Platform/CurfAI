import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { provisionStarterPack } from "@/lib/tenant/provision";
import { ee } from "@/ee";
import { ensureLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

const SignupSchema = z.object({
  workspace: z.string().min(1).max(80),
  email: z.string().email(),
  name: z.string().min(1).max(80).optional(),
  password: z.string().min(8).max(200),
  inviteToken: z.string().optional(),
  // Every signup establishes a new Organization (never joins an existing
  // one — membership growth is invite-only, see /api/admin/users). This
  // choice is purely descriptive: "individual" gets a solo org named after
  // the workspace; "organization" requires a bilingual name pair, since
  // that's what shows up on invoices/branding for a multi-seat account.
  accountType: z.enum(["individual", "organization"]).default("individual"),
  orgNameTh: z.string().min(1).max(120).optional(),
  orgNameEn: z.string().min(1).max(120).optional(),
}).superRefine((data, ctx) => {
  if (data.accountType === "organization") {
    if (!data.orgNameTh) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["orgNameTh"], message: "Organization name (Thai) is required." });
    if (!data.orgNameEn) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["orgNameEn"], message: "Organization name (English) is required." });
  }
});

function slugify(s: string): string {
  return s
    .toLowerCase()
    // Unicode-aware so non-Latin names (e.g. Thai) don't collapse to the
    // "workspace" fallback; \p{M} keeps combining marks (Thai tone/vowel
    // signs) attached instead of splitting words mid-syllable.
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "workspace";
}

async function resolveUniqueSlug(base: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? base : base + "-" + (i + 1);
    const taken = await prisma.tenant.findUnique({ where: { slug: candidate } });
    if (!taken) return candidate;
  }
  return base + "-" + Date.now().toString(36);
}

async function resolveUniqueOrgSlug(base: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? base : base + "-" + (i + 1);
    const taken = await prisma.organization.findUnique({ where: { slug: candidate } });
    if (!taken) return candidate;
  }
  return base + "-" + Date.now().toString(36);
}

export async function POST(req: NextRequest) {
  // Rate-limit by IP — signup creates a new tenant + admin user per call,
  // so an unbounded loop is both an abuse vector and a resource-exhaustion
  // risk, not just an inconvenience.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? req.headers.get("x-real-ip")
    ?? "unknown";
  const limited = ensureLimit("signup", `ip:${ip}`, 5, 5 * 60_000);
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const parsed = SignupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid signup payload", issues: parsed.error.issues }, { status: 400 });
  }

  // Invite-only beta gate. CURF_SIGNUP_OPEN=1 disables the gate entirely
  // (e.g. for the dev seed flow or post-GA when signup is opened).
  let inviteRequestId: string | null = null;
  const inviteToken: string | null = parsed.data.inviteToken ?? body?.inviteToken ?? null;
  // Community has no waitlist: signup is open unless the paid gate is
  // present and CURF_SIGNUP_OPEN isn't set.
  const open = process.env.CURF_SIGNUP_OPEN === "1" || !ee.signupGate;
  if (!open && ee.signupGate) {
    if (!inviteToken) {
      return NextResponse.json(
        { error: "Signup is invite-only during beta. Request access at the home page." },
        { status: 403 },
      );
    }
    const verified = await ee.signupGate.verifyInviteToken(inviteToken);
    if (!verified) {
      return NextResponse.json(
        { error: "Invite link is invalid or expired. Ask your inviter to re-send." },
        { status: 403 },
      );
    }
    // Force the signup email to match the verified invite — defense against
    // someone with the link impersonating an arbitrary email.
    if ((parsed.data.email || "").toLowerCase() !== verified.email.toLowerCase()) {
      return NextResponse.json(
        { error: "Email must match the invite recipient." },
        { status: 403 },
      );
    }
    // Pre-fill workspaceName from invite if the caller didn't supply one.
    if (!parsed.data.workspace && verified.workspaceName) {
      parsed.data.workspace = verified.workspaceName;
    }
    inviteRequestId = verified.id;
  }

  // One global account per email now — signup creates a brand-new person,
  // so an existing row means "you already have an account" rather than a
  // per-tenant name collision. Send them to login instead of silently
  // creating a second identity (or, worse, a second workspace under
  // someone else's password reset flow).
  const existing = await prisma.user.findUnique({ where: { email: parsed.data.email }, select: { id: true } });
  if (existing) {
    return NextResponse.json(
      { error: "An account with that email already exists. Log in instead, or use \"Create workspace\" once you're signed in." },
      { status: 409 },
    );
  }

  const baseSlug = slugify(parsed.data.workspace) || slugify(parsed.data.email.split("@")[1] ?? "workspace");
  const slug = await resolveUniqueSlug(baseSlug);
  const passwordHash = await bcrypt.hash(parsed.data.password, 10);

  try {
    // Auto-generate the per-tenant HMAC webhook signing secret. 32 random
    // bytes hex-encoded → 64 chars; plenty of entropy. Tenants can rotate
    // this from /admin/tenant later. We never echo it back unmasked once
    // saved (same pattern as the Anthropic key).
    const webhookSigningSecret = randomBytes(32).toString("hex");
    // Every signup establishes a brand-new Organization — never joins an
    // existing one (that would be a self-service back door into someone
    // else's per-seat billing; the only way in is an admin-sent invite).
    const orgSlug = await resolveUniqueOrgSlug(slugify(
      parsed.data.accountType === "organization" ? (parsed.data.orgNameTh ?? parsed.data.workspace) : parsed.data.workspace,
    ));
    const organization = await prisma.organization.create({
      data: {
        slug: orgSlug,
        accountType: parsed.data.accountType,
        name: parsed.data.accountType === "organization" ? parsed.data.orgNameTh! : parsed.data.workspace,
        nameEn: parsed.data.accountType === "organization" ? parsed.data.orgNameEn! : null,
      },
    });
    const tenant = await prisma.tenant.create({
      data: { slug, name: parsed.data.workspace, webhookSigningSecret, organizationId: organization.id },
    });
    const user = await prisma.user.create({
      data: {
        email: parsed.data.email,
        name: parsed.data.name ?? null,
        passwordHash,
      },
    });
    await prisma.membership.create({
      data: { userId: user.id, tenantId: tenant.id, role: "admin" },
    });
    // The signer-upper always becomes Platform Admin of the org they just
    // established — harmless at Community tier (see featureGate's
    // "org.platform_admin", Growth+ only) since it's inert until either a
    // second tenant joins the org or the tier unlocks the capability.
    await prisma.orgMembership.create({
      data: { userId: user.id, organizationId: organization.id, role: "platform_admin" },
    });
    const roles = [
      { slug: "analyst",      label: "Analyst",      description: "Full detail." },
      { slug: "new_hire",     label: "New hire",     description: "Simplified view." },
      { slug: "finance_lead", label: "Finance lead", description: "Financial KPIs + audit detail." },
    ];
    for (const r of roles) {
      await prisma.role.create({
        data: { tenantId: tenant.id, slug: r.slug, label: r.label, description: r.description },
      }).catch(() => null);
    }
    recordAudit({
      tenantId: tenant.id,
      userId: user.id,
      userEmail: user.email,
      kind: "tenant.create",
      target: tenant.id,
      req,
      meta: { workspaceName: parsed.data.workspace, slug: tenant.slug },
    });

    // Mark the invite as consumed so the magic link can't be reused.
    if (inviteRequestId) {
      try {
        await prisma.waitlistRequest.update({
          where: { id: inviteRequestId },
          data: { inviteUsedAt: new Date() },
        });
      } catch (e: any) {
        console.warn("[signup] failed to mark invite used:", e?.message ?? e);
      }
    }

    // Auto-install the "wow shot" demo content so the new admin's first
    // workspace impression is the Marketing Campaign Review hero rather
    // than an empty catalog. Best-effort — failure to provision is
    // logged but doesn't break signup.
    let provisioned: { reportsCreated: number; dataSourcesCreated: number; error?: string } = {
      reportsCreated: 0, dataSourcesCreated: 0,
    };
    try {
      const r = await provisionStarterPack(tenant.id);
      provisioned = r;
      if (!r.ok && r.error) {
        console.warn("[signup] starter pack provisioning soft-failed:", r.error);
      }
    } catch (e: any) {
      console.warn("[signup] starter pack threw (continuing without it):", e?.message ?? e);
    }

    return NextResponse.json({
      ok: true,
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
      user: { id: user.id, email: user.email },
      provisioned,
    });
  } catch (e: any) {
    if (e?.code === "P2002") {
      // Race with another signup for the same email between the check above
      // and this insert — same outcome, same message.
      return NextResponse.json(
        { error: "An account with that email already exists. Log in instead." },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: e?.message ?? "Signup failed" }, { status: 500 });
  }
}
