"use client";
/**
 * AutoGenerateButton — the wow-moment trigger.
 *
 * Click → POSTs to /api/reports/auto-generate. UI states:
 *   1. Idle: primary CTA + a small "share publicly" toggle
 *   2. Busy: multi-stage spinner ("Reading your data…", "Designing the
 *      dashboard…", "Composing blocks…", "Publishing public link…")
 *      so the 5–10 second round-trip feels intentional
 *   3. Done: navigates straight into the new report; if a public URL was
 *      minted, the report viewer's existing Share affordances pick it up
 */
import { useState } from "react";
import { Sparkles, Loader2, AlertTriangle, Globe } from "lucide-react";

const STAGES_PRIVATE = [
  "Reading your data…",
  "Designing the dashboard…",
  "Composing blocks…",
  "Almost there…",
];
const STAGES_PUBLIC = [
  "Reading your data…",
  "Designing the dashboard…",
  "Composing blocks…",
  "Publishing public link…",
];

export function AutoGenerateButton({ tableName }: { tableName: string }) {
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Default ON — the wow story is "drop a CSV, get a shareable URL." User
  // can opt out per-generation if the report is sensitive. Setting persists
  // for the session via localStorage so the choice sticks.
  const [publish, setPublish] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem("curf.autoCurf.publish");
    return stored == null ? true : stored === "1";
  });

  function setPublishPersisted(v: boolean) {
    setPublish(v);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("curf.autoCurf.publish", v ? "1" : "0");
    }
  }

  async function generate() {
    setBusy(true); setError(null); setStage(0);
    const stages = publish ? STAGES_PUBLIC : STAGES_PRIVATE;
    const ticker = setInterval(() => setStage((s) => Math.min(s + 1, stages.length - 1)), 1500);
    try {
      const r = await fetch("/api/reports/auto-generate", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lakeTable: tableName, publish }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error ?? `Server returned ${r.status}`);
      // Carry the public URL into the next page via a one-shot
      // sessionStorage handoff — the report viewer (or a small banner
      // wrapper) picks it up + shows the "share this with anyone" toast.
      if (j.publicAppUrl && typeof window !== "undefined") {
        window.sessionStorage.setItem("curf.autoCurf.lastPublicUrl", j.publicAppUrl);
      }
      window.location.href = "/reports/" + j.id;
    } catch (e: any) {
      setError(e?.message ?? "Generate failed");
      setBusy(false);
    } finally {
      clearInterval(ticker);
    }
  }

  const stages = publish ? STAGES_PUBLIC : STAGES_PRIVATE;

  return (
    <>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={generate}
          disabled={busy}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-60"
          title="Let Curf design a complete dashboard from this table"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
          {busy ? stages[stage] : "Auto-generate dashboard"}
        </button>
        {!busy && (
          <label
            className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[10px] font-medium text-muted-foreground hover:bg-muted"
            title="Also create a no-auth public URL anyone can view"
          >
            <input
              type="checkbox"
              checked={publish}
              onChange={(e) => setPublishPersisted(e.target.checked)}
              className="h-3 w-3 accent-primary"
            />
            <Globe className="h-3 w-3" /> Share publicly
          </label>
        )}
      </div>
      {error && (
        <span className="inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          <AlertTriangle className="h-3 w-3" /> {error}
        </span>
      )}
    </>
  );
}
