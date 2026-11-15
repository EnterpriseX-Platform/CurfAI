/**
 * /account — per-user preferences page.
 *
 * Server Component shell that pulls the current user + their preferencesJson
 * from the DB, passes them into the client AccountForm. The form itself
 * holds local state + PUTs back via /api/user/preferences.
 *
 * Also where a console user connects LINE and phone notifications.
 *
 * No tier gate — every plan gets personalization. The whole pitch of
 * personalization is "just for me, doesn't affect what others see."
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { AccountForm } from "./AccountForm";
import { PrivacyPanel } from "./PrivacyPanel";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/layout/PageHeader";
import { ee } from "@/ee";

export const dynamic = "force-dynamic";

async function readLocale(): Promise<Locale> {
  const v = (await cookies()).get("rd_locale")?.value;
  return (LOCALES as readonly string[]).includes(v ?? "") ? (v as Locale) : "en";
}

export default async function AccountPage(props: { searchParams: Promise<{ line?: string }> }) {
  const searchParams = await props.searchParams;
  const session = await getSession();
  const sessionUser = (session?.user as any) ?? null;
  if (!sessionUser?.id) redirect("/login?callbackUrl=/account");
  const locale = await readLocale();

  const row = await prisma.user.findUnique({
    where: { id: sessionUser.id },
    select: { id: true, email: true, name: true, preferencesJson: true } as any,
  });
  let prefs: Record<string, unknown> = {};
  try { prefs = row ? JSON.parse((row as any).preferencesJson || "{}") : {}; } catch {}
  // LINE and phone alerts (paid), as on the Executive view's account page.
  const notify = ee.account
    ? await ee.account.notifyCards({ tenantId: sessionUser.tenantId, userId: sessionUser.id, lineResult: searchParams.line, lineBrief: (prefs as any).lineBrief ?? null })
    : null;

  const sessionsPanel = ee.account ? await ee.account.sessionsPanel() : null;

  return (
    <AppShell breadcrumbs={[{ label: t(locale, "account.pageTitle") }]}>
      <div className="mx-auto max-w-4xl px-8 pb-12 pt-7">
        <PageHeader title={t(locale, "account.pageTitle")} description={t(locale, "account.pageSubtitle").replace("{email}", sessionUser.email)} />

        {notify}
        <AccountForm initial={prefs as any} />
        {sessionsPanel && <div className="mt-10 border-t border-border pt-8">{sessionsPanel}</div>}
        <div className="mt-10 border-t border-border pt-8">
          <PrivacyPanel email={sessionUser.email} />
        </div>
      </div>
    </AppShell>
  );
}
