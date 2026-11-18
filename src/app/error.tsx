"use client";
/**
 * What any page shows when it throws, instead of Next's bare default. One
 * boundary at the root covers every route group; a group that needs its own
 * wording adds its own error.tsx. The digest is the id Next logs the server
 * error under, so a reader can quote it to support without seeing the error.
 */
import Link from "next/link";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { useT } from "@/lib/i18n/LocaleContext";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useT();
  return (
    <main className="flex min-h-[70vh] items-center justify-center px-4 py-12 sm:px-8">
      <EmptyState
        tone="card"
        className="w-full max-w-md"
        icon={<AlertTriangle className="h-5 w-5" aria-hidden />}
        title={t("states.error.title")}
        description={t("states.error.body")}
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={reset}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-ink"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              {t("states.error.retry")}
            </button>
            <Link href="/" className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted">
              {t("states.home")}
            </Link>
          </div>
        }
        preview={error.digest ? (
          <p className="font-mono text-2xs text-faint">{t("states.error.reference")}: {error.digest}</p>
        ) : undefined}
      />
    </main>
  );
}
