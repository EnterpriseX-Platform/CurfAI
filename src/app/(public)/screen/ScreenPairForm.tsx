"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Labels = { title: string; hint: string; connect: string; connecting: string; invalid: string; tooMany: string };

export function ScreenPairForm({ labels }: { labels: Labels }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/screen/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && typeof j.kioskUrl === "string") { window.location.assign(j.kioskUrl); return; }
      setError(r.status === 429 ? labels.tooMany : labels.invalid);
    } catch {
      setError(labels.invalid);
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm space-y-4 text-center" data-testid="screen-pair-form">
      <h1 className="text-lg font-semibold text-foreground">{labels.title}</h1>
      <p className="text-sm text-muted-foreground">{labels.hint}</p>
      <Input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        autoFocus
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        maxLength={12}
        aria-label={labels.title}
        className="h-14 text-center font-mono text-2xl uppercase tracking-widest"
        placeholder="ABCD-EFGH"
      />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" className="w-full" disabled={busy || code.trim().length < 8}>
        {busy ? labels.connecting : labels.connect}
      </Button>
    </form>
  );
}
