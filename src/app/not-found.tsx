/**
 * What an unknown address, or a page that calls notFound(), shows instead of
 * Next's bare 404. It doesn't say whether the item exists elsewhere: a page in
 * another workspace reads the same as one that was never there.
 */
import Link from "next/link";
import { SearchX } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { t } from "@/lib/i18n/dict";
import { serverLocale } from "@/lib/i18n/serverLocale";

export default async function NotFound() {
  const locale = await serverLocale();
  return (
    <main className="flex min-h-[70vh] items-center justify-center px-4 py-12 sm:px-8">
      <EmptyState
        tone="card"
        className="w-full max-w-md"
        icon={<SearchX className="h-5 w-5" aria-hidden />}
        title={t(locale, "states.notFound.title")}
        description={t(locale, "states.notFound.body")}
        action={
          <Link href="/" className="inline-flex rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-ink">
            {t(locale, "states.home")}
          </Link>
        }
      />
    </main>
  );
}
