import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { isPlatformAdmin } from "@/lib/platformAdmin";
import { isOrgPlatformAdminForActiveTenant } from "@/lib/orgAdmin";
import { featureGate } from "@/lib/featureGate";
import { AppShell } from "@/components/layout/AppShell";
import { prisma } from "@/lib/db";
import { UsersManager } from "./UsersManager";
import { OrganizationPanel } from "./OrganizationPanel";
import { BetaRequestsPanel } from "./BetaRequestsPanel";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";
import { PageHeader } from "@/components/layout/PageHeader";

export const dynamic = "force-dynamic";

function readLocale(): Locale {
  const v = cookies().get("rd_locale")?.value;
  return (LOCALES as readonly string[]).includes(v ?? "") ? (v as Locale) : "en";
}

export default async function UsersAdminPage() {
  const session = await getSession();
  const user = (session?.user as any) ?? null;
  if (!session) redirect("/login?callbackUrl=/admin/users");
  if ((session.user as any)?.role !== "admin") redirect("/reports");
  const locale = readLocale();

  const members = await prisma.membership.findMany({
    where: { tenantId: user.tenantId },
    include: { user: { select: { id: true, email: true, name: true } } },
    orderBy: { user: { email: "asc" } },
  });
  const roles = await prisma.role.findMany({ where: { tenantId: user.tenantId }, orderBy: { slug: "asc" } });
  const items = members.map((m: any) => {
    let roleSlugs: string[] = [];
    try { roleSlugs = JSON.parse(m.rolesJson ?? "[]"); } catch { /* */ }
    return { id: m.user.id, email: m.user.email, name: m.user.name, authRole: m.role, roles: roleSlugs };
  });

  // The waitlist is the GLOBAL signup queue (prospects' emails + free-text
  // reasons, no tenantId). Only platform admins may see it — a regular tenant
  // admin must not read other orgs' signup PII. The action side already
  // requires requirePlatformAdmin; this is the matching read-side gate.
  const showWaitlist = isPlatformAdmin(user);
  const pendingRequests = showWaitlist
    ? await prisma.waitlistRequest.findMany({
        where: { status: "pending" },
        orderBy: { createdAt: "asc" },
        take: 50,
        select: {
          id: true, email: true, workspaceName: true, reason: true,
          source: true, status: true, createdAt: true,
        },
      })
    : [];
  const pendingTotal = showWaitlist
    ? await prisma.waitlistRequest.count({ where: { status: "pending" } })
    : 0;

  // Organization tab: Platform Admin of the active tenant's org, on a
  // Growth+ tenant — see src/lib/orgAdmin.ts. Distinct from `isPlatformAdmin`
  // above (that's "Curf's own operators"; this is the customer-facing
  // cross-workspace oversight role).
  const showOrganizationPanel =
    (await isOrgPlatformAdminForActiveTenant(user)) &&
    !(await featureGate(user, "org.platform_admin"));

  return (
    <AppShell breadcrumbs={[{ label: t(locale, "nav.section.admin") }, { label: t(locale, "nav.usersRoles") }]}>
      <div className="mx-auto max-w-5xl px-8 pb-12 pt-7">
        <PageHeader title={t(locale, "nav.usersRoles")} description={t(locale, "adminUsers.pageSubtitle")} />

        <UsersManager initialUsers={items} allRoles={roles} />
        {showOrganizationPanel && (
          <>
            <hr className="my-10 border-border" />
            <OrganizationPanel />
          </>
        )}
        {showWaitlist && (
          <>
            <hr className="my-10 border-border" />
            <BetaRequestsPanel
              initialRows={pendingRequests.map((r: any) => ({
                ...r,
                createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
              }))}
              initialTotal={pendingTotal}
            />
          </>
        )}
      </div>
    </AppShell>
  );
}
