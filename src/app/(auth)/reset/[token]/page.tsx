"use client";
import { useState } from "react";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CurfLogo } from "@/components/common/CurfLogo";

/**
 * Finish a password reset OR accept a workspace invite. The URL carries the
 * raw token; we POST it + the new password to /api/reset which verifies +
 * updates atomically. When ?invite=1 is in the URL, the page swaps copy to
 * "Welcome - set your password to join" so the invitee sees the right framing.
 */
export default function ResetPage() {
  const router = useRouter();
  const params = useParams<{ token: string }>();
  const search = useSearchParams();
  const token = params?.token ?? "";
  const isInvite = search?.get("invite") === "1";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) { setError("Password must be at least 8 characters"); return; }
    if (password !== confirm) { setError("Passwords don't match"); return; }
    setLoading(true);
    try {
      const r = await fetch("/api/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (!r.ok) {
        let msg = "Reset failed";
        try { msg = (await r.json()).error ?? msg; } catch { /* keep default */ }
        setError(msg);
        return;
      }
      setDone(true);
      setTimeout(() => router.push("/login"), 1500);
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
        <h1 className="text-2xl font-semibold tracking-tight">
          {isInvite ? "Welcome - set your password" : "Choose a new password"}
        </h1>
        {isInvite && (
          <p className="mt-2 text-sm text-muted-foreground">
            Pick a password to accept the invite and sign in.
          </p>
        )}

        {done ? (
          <p className="mt-6 rounded-md border border-success/40 bg-success/5 px-3 py-4 text-sm">
            {isInvite ? "Welcome aboard. " : "Password updated. "}Redirecting you to sign in&hellip;
          </p>
        ) : (
          <form onSubmit={submit} className="mt-8 grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="password" className="text-xs font-medium">New password</Label>
              <Input
                id="password" type="password" required minLength={8} autoFocus
                value={password} onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="confirm" className="text-xs font-medium">Confirm</Label>
              <Input
                id="confirm" type="password" required minLength={8}
                value={confirm} onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
            {error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</div>
            )}
            <Button type="submit" disabled={loading}>
              {loading ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Updating&hellip;</> : "Update password"}
            </Button>
          </form>
        )}

        <p className="mt-8 text-center text-xs text-muted-foreground">
          <Link href="/login" className="text-primary underline">Back to sign in</Link>
        </p>
      </div>
    </div>
  );
}
