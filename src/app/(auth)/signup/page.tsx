"use client";
import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, Sparkles, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CurfLogo } from "@/components/common/CurfLogo";
import { useT } from "@/lib/i18n/LocaleContext";

/**
 * Self-serve signup. Creates a new Tenant + admin user and immediately signs
 * in, landing the user at /reports. If the workspace slug collides the API
 * resolves a unique one; the user can rename it later at /admin/tenant.
 *
 * Invite-only beta gating: the API rejects open signups (403) when
 * CURF_SIGNUP_OPEN !== "1" and no inviteToken is provided. We pass through
 * `?invite=<token>` from the magic link, and on a 403-with-invite-only-msg
 * we swap the form for a friendly "private beta" banner.
 */
// Default export is a Suspense-wrapped shell because the inner component
// reads useSearchParams() — Next 14 requires that hook to live inside a
// Suspense boundary during static prerender.
export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupPageInner />
    </Suspense>
  );
}

function SignupPageInner() {
  const { t } = useT();
  const router = useRouter();
  const search = useSearchParams();
  const inviteToken = search?.get("invite") ?? null;
  const [workspace, setWorkspace] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Every signup establishes its own new Organization — never joins an
  // existing one (membership growth is invite-only, see CLAUDE.md). This
  // choice only affects naming: "organization" collects a bilingual name
  // pair for invoicing/branding; "individual" just uses the workspace name.
  const [accountType, setAccountType] = useState<"individual" | "organization">("individual");
  const [orgNameTh, setOrgNameTh] = useState("");
  const [orgNameEn, setOrgNameEn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Set to true when API returns 403 + the "private beta" sentinel — swaps
  // the form for a CTA back to the landing page so the user can request
  // access instead of bouncing off a generic error.
  const [betaBlocked, setBetaBlocked] = useState(false);
  // Set when the account was created but must confirm its email before it
  // can sign in ("sent", or "failed" when the link could not be mailed).
  const [confirmEmail, setConfirmEmail] = useState<"sent" | "failed" | null>(null);
  const [resent, setResent] = useState(false);

  async function resendVerification() {
    setResent(true);
    await fetch("/api/verify-email/resend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }).catch(() => null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBetaBlocked(false);
    setLoading(true);
    try {
      const res = await fetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace, email,
          name: name || undefined,
          password,
          inviteToken: inviteToken || undefined,
          accountType,
          orgNameTh: accountType === "organization" ? orgNameTh : undefined,
          orgNameEn: accountType === "organization" ? orgNameEn : undefined,
        }),
      });
      if (!res.ok) {
        let msg = t("auth.signup.failed");
        let code: string | undefined;
        try {
          const j = await res.json();
          msg = j?.error ?? msg;
          code = j?.code;
        } catch { /* keep default */ }
        // Detect invite-only rejection by status + (code or message text).
        // Backend contract says 403 when invite is missing/invalid and
        // CURF_SIGNUP_OPEN!=1; we look for a code or scan the message.
        if (res.status === 403 && (code === "invite_required" || /invite|beta|closed/i.test(msg))) {
          setBetaBlocked(true);
          return;
        }
        setError(msg);
        return;
      }
      // The address has to be confirmed first: show where to look instead of
      // a sign-in that would be refused.
      let verification: string | undefined;
      let identity: string | undefined;
      try { const j = await res.json(); verification = j?.emailVerification; identity = j?.identity; } catch { /* sign in as before */ }
      if (verification === "sent" || verification === "failed") {
        setConfirmEmail(verification);
        return;
      }
      // Keycloak is the only sign-in: the address is already confirmed (a waitlist invite), so go straight to its login.
      if (identity === "keycloak") {
        await signIn("keycloak", { callbackUrl: "/reports" });
        return;
      }
      // Auto-sign-in with the credentials we just set.
      const signInRes = await signIn("credentials", { email, password, redirect: false });
      if (signInRes?.error) {
        setError(t("auth.signup.signInFailed"));
        return;
      }
      router.push("/reports");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="flex items-center justify-center bg-background px-8 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-10">
            <CurfLogo variant="lockup" size={32} />
          </div>

          {/* Invite banner — only when ?invite= is present. The API enforces
              the email match server-side so we can't decode the email here;
              we just hint the user to use the right address. */}
          {inviteToken && !betaBlocked && !confirmEmail && (
            <InviteBanner token={inviteToken} />
          )}

          {confirmEmail ? (
            <div className="space-y-4">
              <h1 className="text-2xl font-semibold tracking-tight">{t("auth.signup.checkInboxTitle")}</h1>
              <p className="text-sm text-muted-foreground">
                {confirmEmail === "sent"
                  ? t("auth.signup.checkInboxBody").replace("{email}", email)
                  : t("auth.signup.sendFailedBody")}
              </p>
              <div className="flex flex-wrap items-center gap-3 pt-2">
                <Button asChild><Link href="/login">{t("action.signIn")}</Link></Button>
                {resent
                  ? <span className="text-xs text-muted-foreground">{t("auth.login.verificationResent")}</span>
                  : <button type="button" onClick={resendVerification} className="text-xs text-primary underline">{t("auth.login.resendVerification")}</button>}
              </div>
            </div>
          ) : betaBlocked ? (
            <BetaBlockedPanel />
          ) : (
            <>
              <h1 className="text-2xl font-semibold tracking-tight">{t("auth.signup.title")}</h1>
              <p className="mt-1.5 text-sm text-muted-foreground">
                {t("auth.signup.subtitle")}
              </p>

              <form onSubmit={submit} className="mt-8 grid gap-4">
                <div className="grid gap-1.5">
                  <Label className="text-xs font-medium">{t("auth.signup.accountType")}</Label>
                  <div className="grid grid-cols-2 gap-2">
                    {(
                      [
                        { key: "individual", label: t("auth.signup.individual"), hint: t("auth.signup.individualHint") },
                        { key: "organization", label: t("auth.signup.organization"), hint: t("auth.signup.organizationHint") },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.key} type="button"
                        onClick={() => setAccountType(opt.key)}
                        className={
                          "rounded-md border px-3 py-2 text-left text-xs transition-colors " +
                          (accountType === opt.key
                            ? "border-primary/50 bg-primary/5 font-medium text-primary"
                            : "border-border text-muted-foreground hover:bg-muted")
                        }
                      >
                        <span className="block">{opt.label}</span>
                        {/* Shown for BOTH options, always — a first-time user
                            choosing "just a normal account" had no way to know
                            what either choice meant before picking, since this
                            line used to appear only after selecting
                            Organization. */}
                        <span className="mt-0.5 block text-2xs font-normal text-muted-foreground/80">
                          {opt.hint}
                        </span>
                      </button>
                    ))}
                  </div>
                  {accountType === "organization" && (
                    <p className="text-2xs text-muted-foreground">
                      {t("auth.signup.organizationNote")}
                    </p>
                  )}
                </div>
                {accountType === "organization" && (
                  <>
                    <div className="grid gap-1.5">
                      <Label htmlFor="org-name-th" className="text-xs font-medium">{t("auth.signup.orgNameTh")}</Label>
                      <Input
                        id="org-name-th" required
                        placeholder={t("auth.signup.orgNameThPlaceholder")}
                        value={orgNameTh} onChange={(e) => setOrgNameTh(e.target.value)}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="org-name-en" className="text-xs font-medium">{t("auth.signup.orgNameEn")}</Label>
                      <Input
                        id="org-name-en" required
                        placeholder={t("auth.signup.orgNameEnPlaceholder")}
                        value={orgNameEn} onChange={(e) => setOrgNameEn(e.target.value)}
                      />
                    </div>
                  </>
                )}
                <div className="grid gap-1.5">
                  <Label htmlFor="workspace" className="text-xs font-medium">{t("auth.signup.workspaceName")}</Label>
                  <Input
                    id="workspace" required autoFocus
                    placeholder={t("auth.signup.workspacePlaceholder")}
                    value={workspace} onChange={(e) => setWorkspace(e.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="name" className="text-xs font-medium">{t("auth.signup.yourName")}</Label>
                  <Input
                    id="name" placeholder={t("auth.signup.namePlaceholder")}
                    value={name} onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="email" className="text-xs font-medium">{t("auth.login.email")}</Label>
                  <Input
                    id="email" type="email" required
                    placeholder={t("auth.signup.emailPlaceholder")}
                    value={email} onChange={(e) => setEmail(e.target.value)}
                  />
                  {inviteToken && (
                    <p className="text-2xs text-muted-foreground">
                      {t("auth.signup.inviteEmailHint")}
                    </p>
                  )}
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="password" className="text-xs font-medium">{t("auth.login.password")}</Label>
                  <Input
                    id="password" type="password" required minLength={8}
                    placeholder={t("auth.signup.passwordPlaceholder")}
                    value={password} onChange={(e) => setPassword(e.target.value)}
                  />
                </div>

                {error && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                    {error}
                  </div>
                )}
                <Button type="submit" disabled={loading} className="mt-2">
                  {loading ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> {t("action.creating")}</> : t("auth.signup.submit")}
                </Button>
              </form>

              <p className="mt-8 text-center text-xs text-muted-foreground">
                {t("auth.signup.haveAccount")} <Link href="/login" className="text-primary underline">{t("action.signIn")}</Link>
              </p>
            </>
          )}
        </div>
      </div>

      <div className="hidden border-l border-border bg-muted lg:block">
        <div className="flex h-full flex-col justify-between p-12">
          <div className="max-w-md">
            <p className="mb-6 text-xs font-medium uppercase tracking-[.04em] text-muted-foreground">
              {t("landing.heroEyebrow")}
            </p>
            <h2 className="text-3xl font-semibold tracking-tight text-foreground">
              {t("auth.signup.asideTitle")}
            </h2>
            <p className="mt-3 text-sm text-muted-foreground">
              {t("auth.signup.asideBody")}
            </p>
          </div>

          <div className="space-y-3 text-sm">
            {[
              t("auth.signup.asideBullet1"),
              t("auth.signup.asideBullet2"),
              t("auth.signup.asideBullet3"),
            ].map((line) => (
              <div key={line} className="flex items-center gap-2.5 text-foreground/80">
                <div className="h-1.5 w-1.5 rounded-full bg-faint" />
                {line}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function InviteBanner({ token }: { token: string }) {
  const { t } = useT();
  // Token is opaque on the client — we just acknowledge it's present so the
  // user knows they're in the invitee path, not the (gated) self-serve path.
  // Show first/last 4 chars of the token as a tiny breadcrumb to help debug
  // copy-paste mistakes.
  const fp = token.length > 12 ? `${token.slice(0, 4)}…${token.slice(-4)}` : token;
  const [before, after = ""] = t("auth.signup.inviteBody").split("{code}");
  return (
    <div className="mb-6 flex items-start gap-2 rounded-md border border-success/40 bg-success/5 px-3 py-2 text-xs text-success  ">
      <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div>
        <p className="font-semibold">{t("auth.signup.inviteTitle")}</p>
        <p className="mt-0.5 text-success/80 ">
          {before}<code className="font-mono">{fp}</code>{after}
        </p>
      </div>
    </div>
  );
}

function BetaBlockedPanel() {
  const { t } = useT();
  const [hintBefore, hintAfter = ""] = t("auth.signup.betaInviteHint").split("{code}");
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">{t("auth.signup.betaTitle")}</h1>
      <p className="text-sm text-muted-foreground">
        {t("auth.signup.betaBody")}
      </p>
      <div className="flex gap-2 pt-2">
        <Button asChild>
          <Link href="/">
            <ArrowLeft className="mr-1.5 h-4 w-4" /> {t("auth.signup.requestAccess")}
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/login">{t("action.signIn")}</Link>
        </Button>
      </div>
      <p className="pt-4 text-2xs text-muted-foreground">
        {hintBefore}<code className="font-mono">?invite=</code>{hintAfter}
      </p>
    </div>
  );
}
