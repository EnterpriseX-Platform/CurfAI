"use client";
import { useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CurfLogo } from "@/components/common/CurfLogo";

/**
 * "Forgot password" form. Always shows a success message regardless of
 * whether the email matches a real user - we don't leak account existence.
 */
export default function ForgotPage() {
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

        <h1 className="text-2xl font-semibold tracking-tight">Forgot your password?</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Enter the email you signed up with. If there's a matching account,
          we'll send you a reset link that lasts 60 minutes.
        </p>

        {sent ? (
          <div className="mt-8 rounded-md border border-success/40 bg-success/5 px-3 py-4 text-sm">
            <p className="font-medium text-success-foreground">Check your inbox.</p>
            <p className="mt-1 text-muted-foreground">
              If you don't see it within a few minutes, check spam or try again with another address.
            </p>
            <div className="mt-4">
              <Link href="/login" className="text-xs text-primary underline">Back to sign in</Link>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-8 grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="email" className="text-xs font-medium">Email</Label>
              <Input
                id="email" type="email" required autoFocus
                placeholder="you@company.com"
                value={email} onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={loading}>
              {loading ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Sending&hellip;</> : "Send reset link"}
            </Button>
          </form>
        )}

        <p className="mt-8 text-center text-xs text-muted-foreground">
          Remember it? <Link href="/login" className="text-primary underline">Sign in</Link>.
        </p>
      </div>
    </div>
  );
}
