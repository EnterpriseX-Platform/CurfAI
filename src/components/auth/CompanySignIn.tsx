"use client";
/**
 * "Sign in with your company account": the work email decides which company provider to use (identity-first). The answer comes
 * from /api/sso-discover; the person is then sent to Keycloak, which goes straight to that provider. Companies' providers are not
 * listed anywhere, so this is the only door to them.
 */
import { useState } from "react";
import { signIn } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n/LocaleContext";

export function CompanySignIn({ callbackUrl }: { callbackUrl: string }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [none, setNone] = useState(false);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNone(false);
    try {
      const r = await fetch("/api/sso-discover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
      const j = r.ok ? await r.json() : null;
      if (j?.alias) {
        // prompt=login: an existing Keycloak session must not skip the company provider.
        await signIn("keycloak", { callbackUrl }, { kc_idp_hint: j.alias, login_hint: email, prompt: "login" });
        return;
      }
      setNone(true);
    } finally { setBusy(false); }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-3 w-full text-center text-xs font-medium text-primary underline" data-testid="company-sso-open">
        {t("auth.login.companySso")}
      </button>
    );
  }
  return (
    <form onSubmit={go} className="mt-4 grid gap-2" data-testid="company-sso-form">
      <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("auth.login.companyEmail")} aria-label={t("auth.login.companyEmail")} required autoFocus />
      <Button type="submit" variant="outline" disabled={busy || !email.trim()}>
        {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}{t("auth.login.companyContinue")}
      </Button>
      {none && <p className="text-xs text-destructive" role="alert">{t("auth.login.companyNone")}</p>}
    </form>
  );
}
