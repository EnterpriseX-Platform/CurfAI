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
        let msg = "Signup failed";
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
      // Auto-sign-in with the credentials we just set.
      const signInRes = await signIn("credentials", { email, password, redirect: false });
      if (signInRes?.error) {
        setError("Account created, but sign-in failed. Try /login.");
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
          {inviteToken && !betaBlocked && (
            <InviteBanner token={inviteToken} />
          )}

          {betaBlocked ? (
            <BetaBlockedPanel />
          ) : (
            <>
              <h1 className="text-2xl font-semibold tracking-tight">Create your workspace</h1>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Spin up a fresh tenant in under a minute. You&apos;ll be the admin.
              </p>

              <form onSubmit={submit} className="mt-8 grid gap-4">
                <div className="grid gap-1.5">
                  <Label className="text-xs font-medium">Account type</Label>
                  <div className="grid grid-cols-2 gap-2">
                    {(
                      [
                        { key: "individual", label: "Individual", hint: "Just you — you'll be the workspace admin." },
                        { key: "organization", label: "Organization", hint: "Multiple workspaces — you'll be Platform Admin." },
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
                        <span className="mt-0.5 block text-[10px] font-normal text-muted-foreground/80">
                          {opt.hint}
                        </span>
                      </button>
                    ))}
                  </div>
                  {accountType === "organization" && (
                    <p className="text-[11px] text-muted-foreground">
                      You&apos;ll become Platform Admin — able to oversee every workspace under this
                      organization and invite others to help manage it.
                    </p>
                  )}
                </div>
                {accountType === "organization" && (
                  <>
                    <div className="grid gap-1.5">
                      <Label htmlFor="org-name-th" className="text-xs font-medium">Organization name (Thai)</Label>
                      <Input
                        id="org-name-th" required
                        placeholder="บริษัท ตัวอย่าง จำกัด"
                        value={orgNameTh} onChange={(e) => setOrgNameTh(e.target.value)}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="org-name-en" className="text-xs font-medium">Organization name (English)</Label>
                      <Input
                        id="org-name-en" required
                        placeholder="Example Co., Ltd."
                        value={orgNameEn} onChange={(e) => setOrgNameEn(e.target.value)}
                      />
                    </div>
                  </>
                )}
                <div className="grid gap-1.5">
                  <Label htmlFor="workspace" className="text-xs font-medium">Workspace name</Label>
                  <Input
                    id="workspace" required autoFocus
                    placeholder="Acme Corp"
                    value={workspace} onChange={(e) => setWorkspace(e.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="name" className="text-xs font-medium">Your name (optional)</Label>
                  <Input
                    id="name" placeholder="Alex Chen"
                    value={name} onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="email" className="text-xs font-medium">Email</Label>
                  <Input
                    id="email" type="email" required
                    placeholder="you@company.com"
                    value={email} onChange={(e) => setEmail(e.target.value)}
                  />
                  {inviteToken && (
                    <p className="text-[11px] text-muted-foreground">
                      Use the email this invite was sent to.
                    </p>
                  )}
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="password" className="text-xs font-medium">Password</Label>
                  <Input
                    id="password" type="password" required minLength={8}
                    placeholder="8+ characters"
                    value={password} onChange={(e) => setPassword(e.target.value)}
                  />
                </div>

                {error && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                    {error}
                  </div>
                )}
                <Button type="submit" disabled={loading} className="mt-2">
                  {loading ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Creating&hellip;</> : "Create workspace"}
                </Button>
              </form>

              <p className="mt-8 text-center text-xs text-muted-foreground">
                Already have an account? <Link href="/login" className="text-primary underline">Sign in</Link>.
              </p>
            </>
          )}
        </div>
      </div>

      <div className="relative hidden overflow-hidden bg-gradient-chrome lg:block">
        <div className="absolute inset-0 opacity-60">
          <div className="absolute -top-24 -right-24 h-96 w-96 rounded-full bg-primary/20 blur-3xl" />
          <div className="absolute bottom-0 left-1/4 h-80 w-80 rounded-full bg-primary/10 blur-3xl" />
        </div>
        <div className="relative flex h-full flex-col justify-between p-12">
          <div className="max-w-md">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
              The living-reports platform
            </div>
            <h2 className="text-3xl font-semibold tracking-tight text-foreground">
              Your own workspace, your own data.
            </h2>
            <p className="mt-3 text-sm text-muted-foreground">
              Every record in Curf is tenant-scoped. Two tenants can share email addresses,
              connection names, and role slugs - your data is strictly yours.
            </p>
          </div>

          <div className="space-y-3 text-sm">
            {[
              "Designer, templates, exports, schedules - out of the box",
              "Trust Layer: proof-carrying cells, time-travel replay",
              "Intelligence: Talks-back Q&A, role-gated blocks, actions",
            ].map((t) => (
              <div key={t} className="flex items-center gap-2.5 text-foreground/80">
                <div className="h-1.5 w-1.5 rounded-full bg-primary" />
                {t}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function InviteBanner({ token }: { token: string }) {
  // Token is opaque on the client — we just acknowledge it's present so the
  // user knows they're in the invitee path, not the (gated) self-serve path.
  // Show first/last 4 chars of the token as a tiny breadcrumb to help debug
  // copy-paste mistakes.
  const fp = token.length > 12 ? `${token.slice(0, 4)}…${token.slice(-4)}` : token;
  return (
    <div className="mb-6 flex items-start gap-2 rounded-md border border-success/40 bg-success/5 px-3 py-2 text-xs text-success  ">
      <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div>
        <p className="font-semibold">Beta invite — completing signup</p>
        <p className="mt-0.5 text-success/80 ">
          Your invite is attached (<code className="font-mono">{fp}</code>). Finish below to create your workspace.
        </p>
      </div>
    </div>
  );
}

function BetaBlockedPanel() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Curf is in private beta.</h1>
      <p className="text-sm text-muted-foreground">
        Self-serve signup is closed for now. Drop your email on the home page and
        we&apos;ll send a magic link within 24 hours.
      </p>
      <div className="flex gap-2 pt-2">
        <Button asChild>
          <Link href="/">
            <ArrowLeft className="mr-1.5 h-4 w-4" /> Request access
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/login">Sign in</Link>
        </Button>
      </div>
      <p className="pt-4 text-[11px] text-muted-foreground">
        If you already have an invite, make sure you opened the magic link directly —
        it carries the <code className="font-mono">?invite=</code> token this page needs.
      </p>
    </div>
  );
}
