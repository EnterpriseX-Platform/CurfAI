/**
 * /account — per-user preferences page.
 *
 * Server Component shell that pulls the current user + their preferencesJson
 * from the DB, passes them into the client AccountForm. The form itself
 * holds local state + PUTs back via /api/user/preferences.
 *
 * No tier gate — every plan gets personalization. The whole pitch of
 * personalization is "just for me, doesn't affect what others see."
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { AccountForm } from "./AccountForm";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/layout/PageHeader";

export const dynamic = "force-dynamic";

function readLocale(): Locale {
  const v = cookies().get("rd_locale")?.value;
  return (LOCALES as readonly string[]).includes(v ?? "") ? (v as Locale) : "en";
}

export default async function AccountPage() {
  const session = await getSession();
  const sessionUser = (session?.user as any) ?? null;
  if (!sessionUser?.id) redirect("/login?callbackUrl=/account");
  const locale = readLocale();

  const row = await prisma.user.findUnique({
    where: { id: sessionUser.id },
    select: { id: true, email: true, name: true, preferencesJson: true } as any,
  });
  let prefs: Record<string, unknown> = {};
  try { prefs = row ? JSON.parse((row as any).preferencesJson || "{}") : {}; } catch {}

  return (
    <AppShell breadcrumbs={[{ label: t(locale, "account.pageTitle") }]}>
      <div className="mx-auto max-w-3xl px-8 pb-12 pt-7">
        <PageHeader title={t(locale, "account.pageTitle")} description={t(locale, "account.pageSubtitle").replace("{email}", sessionUser.email)} />

        <AccountForm initial={prefs as any} />
      </div>
    </AppShell>
  );
}
