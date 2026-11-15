"use client";
import { useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CurfLogo } from "@/components/common/CurfLogo";
import { useT } from "@/lib/i18n/LocaleContext";

/**
 * "Forgot password" form. Always shows a success message regardless of
 * whether the email matches a real user - we don't leak account existence.
 */
export default function ForgotPage() {
  const { t } = useT();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await fetch("/api/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setSent(true);
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

        <h1 className="text-2xl font-semibold tracking-tight">{t("auth.forgot.title")}</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {t("auth.forgot.subtitle")}
        </p>

        {sent ? (
          <div className="mt-8 rounded-md border border-success/40 bg-success/5 px-3 py-4 text-sm">
            <p className="font-medium text-success-foreground">{t("auth.forgot.sentTitle")}</p>
            <p className="mt-1 text-muted-foreground">
              {t("auth.forgot.sentBody")}
            </p>
            <div className="mt-4">
              <Link href="/login" className="text-xs text-primary underline">{t("auth.forgot.backToSignIn")}</Link>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-8 grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="email" className="text-xs font-medium">{t("auth.login.email")}</Label>
              <Input
                id="email" type="email" required autoFocus
                placeholder={t("auth.signup.emailPlaceholder")}
                value={email} onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={loading}>
              {loading ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> {t("auth.forgot.sending")}</> : t("auth.forgot.submit")}
            </Button>
          </form>
        )}

        <p className="mt-8 text-center text-xs text-muted-foreground">
          {t("auth.forgot.remember")} <Link href="/login" className="text-primary underline">{t("action.signIn")}</Link>
        </p>
      </div>
    </div>
  );
}
