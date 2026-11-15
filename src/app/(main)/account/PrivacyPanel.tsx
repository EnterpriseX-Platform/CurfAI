"use client";
/**
 * PrivacyPanel — /account's "Your data" section: download what Curf holds about you, or erase your account.
 * The server decides everything (lib/lifecycle/person.ts); this only collects the confirmation and shows what blocks it.
 */
import { useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n/LocaleContext";

type Blocker = { tenantId: string; workspace: string; why: string };

export function PrivacyPanel({ email }: { email: string }) {
  const { t } = useT();
  const [blockers, setBlockers] = useState<Blocker[]>([]);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/me/erase", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j) { setBlockers(j.blockers ?? []); setNeedsPassword(!!j.needsPassword); } })
      .catch(() => null);
  }, []);

  async function erase() {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/me/erase", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmEmail, password }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j.error ?? "Failed"); return; }
      await signOut({ callbackUrl: "/login" });
    } finally { setBusy(false); }
  }

  const ready = confirmEmail.trim().toLowerCase() === email.toLowerCase() && (!needsPassword || password.length > 0) && blockers.length === 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{t("account.privacyHeading")}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("account.privacyHint")}</p>
      </div>
      <Button asChild variant="outline" size="sm">
        <a href="/api/me/data-export" download><Download className="mr-2 h-4 w-4" />{t("account.downloadMyData")}</a>
      </Button>

      <div className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-4">
        <h3 className="text-sm font-medium text-destructive">{t("account.eraseHeading")}</h3>
        <p className="text-xs text-muted-foreground">{t("account.eraseDesc")}</p>
        {blockers.map((b) => (
          <p key={b.tenantId} className="text-xs text-warning">{t("account.eraseBlocked").replace("{workspace}", b.workspace).replace("{why}", b.why)}</p>
        ))}
        <Input value={confirmEmail} onChange={(e) => setConfirmEmail(e.target.value)} placeholder={t("account.eraseConfirmEmail")} autoComplete="off" />
        {needsPassword && (
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t("account.erasePassword")} autoComplete="current-password" />
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button variant="destructive" size="sm" disabled={!ready || busy} onClick={erase}>{t("account.eraseButton")}</Button>
      </div>
    </div>
  );
}
