"use client";
import { Suspense, useState, useEffect } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CurfLogo } from "@/components/common/CurfLogo";
import { useT } from "@/lib/i18n/LocaleContext";
import { eeClient } from "@/ee/client";

const IS_COMMUNITY = eeClient.edition === "community";

// Statically replaced at build time, so the production bundle contains no
// trace of the dev credentials — neither prefilled nor printed. A public
// login page that hands out an admin password is an open door, not a hint.
const IS_DEV = process.env.NODE_ENV !== "production";

function LoginForm() {
  const { t } = useT();
  const router = useRouter();
  const sp = useSearchParams();
  const callbackUrl = sp.get("callbackUrl") ?? "/reports";

  const [email, setEmail] = useState(IS_DEV ? "admin@curf.local" : "");
  const [password, setPassword] = useState(IS_DEV ? "admin123" : "");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [ssoProviders, setSsoProviders] = useState<string[]>([]);

  useEffect(() => {
    fetch("/api/sso-providers").then((r) => r.ok ? r.json() : { providers: [] })
      .then((j) => setSsoProviders(j.providers ?? []))
      .catch(() => setSsoProviders([]));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const res = await signIn("credentials", { email, password, redirect: false });
    setLoading(false);
    if (res?.error) setError(t("auth.login.invalidCredentials"));
    else router.push(callbackUrl);
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

          <form onSubmit={submit} className="mt-8 grid gap-4">
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
                <a href="/forgot" className="text-[11px] text-muted-foreground hover:text-primary hover:underline">{t("auth.login.forgot")}</a>
              </div>
              <Input
                id="password" type="password" value={password}
                onChange={(e) => setPassword(e.target.value)} required
              />
            </div>
            {error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            )}
            <Button type="submit" disabled={loading} className="mt-2">
              {loading ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> {t("auth.login.signingIn")}</> : t("action.signIn")}
            </Button>
          </form>

          {ssoProviders.length > 0 && (
            <>
              <div className="my-6 flex items-center gap-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <div className="h-px flex-1 bg-border" />
                {t("auth.login.orContinueWith")}
                <div className="h-px flex-1 bg-border" />
              </div>
              <div className="grid gap-2">
                {ssoProviders.includes("google") && (
                  <Button variant="outline" className="w-full" onClick={() => signIn("google", { callbackUrl })}>
                    {t("auth.login.continueWithGoogle")}
                  </Button>
                )}
                {ssoProviders.includes("github") && (
                  <Button variant="outline" className="w-full" onClick={() => signIn("github", { callbackUrl })}>
                    {t("auth.login.continueWithGithub")}
                  </Button>
                )}
              </div>
            </>
          )}

          {IS_DEV && (
            <p className="mt-8 text-[11px] text-muted-foreground">
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
      <div className="relative hidden overflow-hidden bg-gradient-chrome lg:block">
        <div className="absolute inset-0 opacity-60">
          <div className="absolute -top-24 -right-24 h-96 w-96 rounded-full bg-primary/20 blur-3xl" />
          <div className="absolute bottom-0 left-1/4 h-80 w-80 rounded-full bg-primary/10 blur-3xl" />
        </div>
        <div className="relative flex h-full flex-col justify-between p-12">
          <div className="max-w-md">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
              {t("landing.heroEyebrow")}
            </div>
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
                <div className="h-1.5 w-1.5 rounded-full bg-primary" />
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
