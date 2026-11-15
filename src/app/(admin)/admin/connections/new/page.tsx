/**
 * /admin/connections/new — wizard for creating a new SyncConnection.
 *
 * Single-page form (not a stepped modal) so the user can see the whole
 * decision tree at once: pick kind → fill credentials → pick objects →
 * pick schedule → submit. POST /api/admin/connections does the writes
 * atomically and returns a connectionId we redirect to.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { AppShell } from "@/components/layout/AppShell";
import { NewConnectionWizard } from "./NewConnectionWizard";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";

export const dynamic = "force-dynamic";

async function readLocale(): Promise<Locale> {
  const v = (await cookies()).get("rd_locale")?.value;
  return (LOCALES as readonly string[]).includes(v ?? "") ? (v as Locale) : "en";
}

export default async function NewConnectionPage() {
  const user = await requireUser();
  if (!user) redirect("/login?next=/admin/connections/new");
  if (user.role !== "admin") redirect("/");
  const locale = await readLocale();

  return (
    <AppShell breadcrumbs={[
      { label: t(locale, "nav.section.admin") },
      { label: t(locale, "nav.connections"), href: "/admin/connections" },
      { label: t(locale, "breadcrumb.new") },
    ]}>
      <div className="mx-auto max-w-4xl px-8 pb-12 pt-7">
        <NewConnectionWizard />
      </div>
    </AppShell>
  );
}
