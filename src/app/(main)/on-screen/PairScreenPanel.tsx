"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { MonitorUp } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";
import { useToast } from "@/lib/toast";

/** "Send to a screen": a short code for this display that a wall screen types in at /screen. */
export function PairScreenPanel({ onScreenId }: { onScreenId: string }) {
  const { t } = useT();
  const { push } = useToast();
  const [fresh, setFresh] = useState<{ code: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!fresh) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [fresh]);

  async function generate() {
    setBusy(true);
    try {
      const r = await fetch(`/api/on-screen/${onScreenId}/pairing`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error ?? `Server returned ${r.status}`);
      setFresh({ code: j.code, expiresAt: new Date(j.expiresAt).getTime() });
      setNow(Date.now());
    } catch (err: any) {
      push({ variant: "destructive", title: t("screenPair.generateFailed"), description: err?.message });
    } finally {
      setBusy(false);
    }
  }

  const left = fresh ? Math.max(0, Math.ceil((fresh.expiresAt - now) / 1000)) : 0;
  const live = fresh && left > 0;

  return (
    <div className="rounded-lg border border-border bg-card p-4" data-testid="pair-screen-panel">
      <p className="text-xs text-muted-foreground">{t("screenPair.adminHint")}</p>
      {live && (
        <div className="mt-3">
          <p className="font-mono text-3xl font-semibold tracking-widest text-foreground" data-testid="pair-screen-code">{fresh.code}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("screenPair.expiresIn").replace("{m}", String(Math.floor(left / 60))).replace("{s}", String(left % 60).padStart(2, "0"))}
          </p>
        </div>
      )}
      {fresh && !live && <p className="mt-3 text-xs text-warning">{t("screenPair.expired")}</p>}
      <Button type="button" size="sm" variant="outline" className="mt-3" onClick={generate} disabled={busy}>
        <MonitorUp className="mr-1.5 h-4 w-4" /> {t(fresh ? "screenPair.newCode" : "screenPair.generate")}
      </Button>
    </div>
  );
}
