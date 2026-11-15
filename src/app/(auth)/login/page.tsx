"use client";
import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CurfLogo } from "@/components/common/CurfLogo";
import { useT } from "@/lib/i18n/LocaleContext";
import { eeClient } from "@/ee/client";
import { sameSitePath } from "@/lib/http/safePath";
import { useSignInOptions, startSocialSignIn } from "@/lib/useSignInOptions";
import { CompanySignIn } from "@/components/auth/CompanySignIn";

const IS_COMMUNITY = eeClient.edition === "community";

// Statically replaced at build time, so the production bundle contains no
// trace of the dev credentials — neither prefilled nor printed. A public
// login page that hands out an admin password is an open door, not a hint.
const IS_DEV = process.env.NODE_ENV !== "production";

function LoginForm() {
  const { t } = useT();
  const sp = useSearchParams();
  // "/" decides where a signed-in member lands (src/app/page.tsx) — one
  // place, instead of login sending people to /reports while "/" sent them to /brief.
  // Only a path on this site — never another origin after sign-in.
  const callbackUrl = sameSitePath(sp.get("callbackUrl"));

  const [email, setEmail] = useState(IS_DEV ? "admin@curf.local" : "");
  const [password, setPassword] = useState(IS_DEV ? "admin123" : "");
  // A Google/GitHub sign-in that was refused comes back here with ?error=
  // (lib/ssoSignIn.ts; NextAuth's own OAuth failures use the same param).
  const ssoError = sp.get("error");
  const ssoErrorKey = !ssoError ? null
    : ssoError === "sso_no_account" ? "auth.login.ssoNoAccount"
    : ssoError === "sso_email_unverified" ? "auth.login.ssoUnverified"
    : ssoError === "sso_workspace_suspended" ? "auth.login.workspaceSuspended"
    : ssoError === "sso_sso_required" ? "auth.login.ssoRequired"
    : ssoError === "sso_mfa_required" ? "auth.login.ssoMfaRequired"
    : ssoError === "sso_sso_domain_mismatch" ? "auth.login.ssoDomainMismatch"
    : ssoError === "sso_sso_not_enabled" ? "auth.login.ssoNotEnabled"
    : ssoError === "sso_identity_conflict" || ssoError === "sso_session_revoked" ? "auth.login.ssoConflict"
    : "auth.login.ssoFailed";
  const [ssoDismissed, setSsoDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shownError = error ?? (ssoErrorKey && !ssoDismissed ? t(ssoErrorKey) : null);
  const [loading, setLoading] = useState(false);
  // The password was right but the email was never confirmed (lib/auth.ts
  // EMAIL_NOT_VERIFIED): offer to send the link again.
  const [unverified, setUnverified] = useState(false);
  const [resent, setResent] = useState(false);
  const options = useSignInOptions();
  const ssoProviders = options.providers;
  // Keycloak as the only sign-in: no password form, no separate Google/GitHub providers (they go through Keycloak).
  const showForm = options.loaded && options.passwordLogin;
  const socials = (["google", "github"] as const).filter((p) => ssoProviders.includes(p) || options.brokered.includes(p));

  async function resendVerification() {
    setResent(true);
    // Same answer whether or not the address has an account — nothing to branch on.
    await fetch("/api/verify-email/resend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }).catch(() => null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSsoDismissed(true);
    setUnverified(false);
    setResent(false);
    setLoading(true);
    try {
      const res = await signIn("credentials", { email, password, redirect: false });
      if (res?.ok && !res.error) {
        // A full navigation, not router.push: the next page must be requested
        // with the session cookie this response just set.
        window.location.assign(callbackUrl);
        return;
      }
      // "CredentialsSignin" is a wrong email or password; the sign-in limiter
      // and a server that cannot answer (database down) carry their own message.
      const err = res?.error ?? "";
      // Matches lib/auth.ts EMAIL_NOT_VERIFIED (a client component can't import it).
      if (err === "Email not verified") setUnverified(true);
      setError(t(err === "CredentialsSignin" ? "auth.login.invalidCredentials"
        : err === "Email not verified" ? "auth.login.emailUnverified"
        // Matches lib/auth.ts WORKSPACE_SUSPENDED.
        : err === "Workspace suspended" ? "auth.login.workspaceSuspended"
        // Matches lib/auth.ts USE_IDENTITY_PROVIDER.
        : err === "Use single sign-on" ? "auth.login.useSso"
        : err.startsWith("Too many") ? "auth.login.tooMany" : "auth.login.unreachable"));
    } catch {
      setError(t("auth.login.unreachable"));
    }
    setLoading(false);
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Left — form */}
      <div className="flex items-center justify-center bg-background px-8 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-10">
            <CurfLogo variant="lockup" size={32} />
          </div>

          <h1 className="text-2xl font-semibold tracking-tight">{t("auth.login.welcomeBack")}</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">{t("auth.login.subtitle")}</p>

          {ssoProviders.includes("keycloak") && (
            <div className="mt-8 grid gap-2">
              {/* After a refusal the person still has a Keycloak session; without prompt=login "Continue" would silently sign them in as the same refused identity again. */}
              <Button className="w-full" onClick={() => signIn("keycloak", { callbackUrl }, ssoError ? { prompt: "login" } : undefined)}>
                {t("auth.login.continueWithSso")}
              </Button>
              {ssoError === "sso_mfa_required" && (
                // The organisation requires a second factor: send the person back to Keycloak asking for it.
                <Button variant="outline" className="w-full" onClick={() => signIn("keycloak", { callbackUrl }, { acr_values: "2" })}>
                  {t("auth.login.ssoMfaRetry")}
                </Button>
              )}
            </div>
          )}

          {options.companySso && <CompanySignIn callbackUrl={callbackUrl} />}

          {!options.loaded && <div className="mt-8 h-10" aria-hidden />}
          {shownError && !showForm && (
            <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{shownError}</div>
          )}
          {showForm && <form onSubmit={submit} className="mt-8 grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="email" className="text-xs font-medium text-foreground">{t("auth.login.email")}</Label>
              <Input
                id="email" type="email" value={email}
                onChange={(e) => setEmail(e.target.value)} required autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="password" className="text-xs font-medium text-foreground">{t("auth.login.password")}</Label>
                <a href="/forgot" className="text-2xs text-muted-foreground hover:text-primary hover:underline">{t("auth.login.forgot")}</a>
              </div>
              <Input
                id="password" type="password" value={password}
                onChange={(e) => setPassword(e.target.value)} required
              />
            </div>
            {shownError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {shownError}
                {unverified && (
                  <div className="mt-2">
                    {resent
                      ? <span className="text-muted-foreground">{t("auth.login.verificationResent")}</span>
                      : <button type="button" onClick={resendVerification} className="font-medium underline">{t("auth.login.resendVerification")}</button>}
                  </div>
                )}
              </div>
            )}
            <Button type="submit" disabled={loading} className="mt-2">
              {loading ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> {t("auth.login.signingIn")}</> : t("action.signIn")}
            </Button>
          </form>}

          {socials.length > 0 && (
            <>
              {showForm && (
                <div className="my-6 flex items-center gap-3 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <div className="h-px flex-1 bg-border" />
                  {t("auth.login.orContinueWith")}
                  <div className="h-px flex-1 bg-border" />
                </div>
              )}
              <div className={showForm ? "grid gap-2" : "mt-3 grid gap-2"}>
                {socials.includes("google") && (
                  <Button variant="outline" className="w-full" onClick={() => startSocialSignIn("google", options, callbackUrl)}>
                    {t("auth.login.continueWithGoogle")}
                  </Button>
                )}
                {socials.includes("github") && (
                  <Button variant="outline" className="w-full" onClick={() => startSocialSignIn("github", options, callbackUrl)}>
                    {t("auth.login.continueWithGithub")}
                  </Button>
                )}
              </div>
            </>
          )}
          {IS_DEV && showForm && (
            <p className="mt-8 text-2xs text-muted-foreground">
              Dev credentials: <span className="font-mono">admin@curf.local</span> / <span className="font-mono">admin123</span>
            </p>
          )}
          <p className="mt-3 text-center text-xs text-muted-foreground">
            {t("auth.login.newToCurf")} <a href="/signup" className="text-primary underline">{t("auth.login.createWorkspace")}</a>.
          </p>
          {!IS_COMMUNITY && (
            <p className="mt-2 text-center text-xs text-muted-foreground">
              {t("auth.login.viewerQuestion")} <a href="/portal/login" className="text-primary underline">{t("auth.login.viewerCta")}</a>
            </p>
          )}
        </div>
      </div>

      {/* Right — marketing/hero */}
      <div className="hidden border-l border-border bg-muted lg:block">
        <div className="flex h-full flex-col justify-between p-12">
          <div className="max-w-md">
            <p className="mb-6 text-xs font-medium uppercase tracking-[.04em] text-muted-foreground">
              {t("landing.heroEyebrow")}
            </p>
            <h2 className="text-3xl font-semibold tracking-tight text-foreground">
              {t("brand.tagline")}
            </h2>
            <p className="mt-3 text-sm text-muted-foreground">
              {t(IS_COMMUNITY ? "auth.login.communitySubtitle" : "landing.heroSubtitle")}
            </p>
          </div>

          <div className="space-y-3 text-sm">
            {(IS_COMMUNITY
              ? [t("auth.login.communityBullet1"), t("auth.login.communityBullet2"), t("auth.login.communityBullet3")]
              : [t("auth.login.bullet1"), t("auth.login.bullet2"), t("auth.login.bullet3")]
            ).map((bullet) => (
              <div key={bullet} className="flex items-center gap-2.5 text-foreground/80">
                <div className="h-1.5 w-1.5 rounded-full bg-faint" />
                {bullet}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="grid min-h-screen place-items-center text-sm text-muted-foreground">Loading…</div>}>
      <LoginForm />
    </Suspense>
  );
}
