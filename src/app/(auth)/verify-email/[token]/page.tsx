"use client";
import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CurfLogo } from "@/components/common/CurfLogo";
import { useT } from "@/lib/i18n/LocaleContext";

/**
 * Landing page for the link mailed after signup. The token is used by the
 * button, not on page load: mail scanners and link previews open every URL in
 * a message, and would use up a single-use link before the person got to it.
 */
export default function VerifyEmailPage() {
  const { t } = useT();
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setError(null);
    setLoading(true);
    try {
      const r = await fetch("/api/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!r.ok) {
        setError(t("auth.verify.invalid"));
        return;
      }
      setDone(true);
    } catch {
      setError(t("auth.verify.failed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-background px-6">
      <div className="w-full max-w-sm">
        <div className="mb-10">
          <CurfLogo variant="lockup" size={32} />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("auth.verify.title")}</h1>

        {done ? (
          <div className="mt-6 rounded-md border border-success/40 bg-success/5 px-3 py-4 text-sm">
            <p className="font-medium">{t("auth.verify.done")}</p>
            <div className="mt-4">
              <Button asChild size="sm"><Link href="/login">{t("action.signIn")}</Link></Button>
            </div>
          </div>
        ) : (
          <>
            <p className="mt-2 text-sm text-muted-foreground">{t("auth.verify.subtitle")}</p>
            {error && (
              <div className="mt-6 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</div>
            )}
            <Button onClick={confirm} disabled={loading} className="mt-6 w-full">
              {loading ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> {t("auth.verify.confirming")}</> : t("auth.verify.confirm")}
            </Button>
          </>
        )}

        <p className="mt-8 text-center text-xs text-muted-foreground">
          <Link href="/login" className="text-primary underline">{t("auth.forgot.backToSignIn")}</Link>
        </p>
      </div>
    </div>
  );
}
