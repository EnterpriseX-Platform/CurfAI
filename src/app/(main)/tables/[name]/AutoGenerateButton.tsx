"use client";
/**
 * AutoGenerateButton — the wow-moment trigger.
 *
 * Click → POSTs to /api/reports/auto-generate. UI states:
 *   1. Idle: primary CTA + an opt-in "also create a public link" toggle
 *   2. Busy: multi-stage spinner ("Reading your data…", "Designing the
 *      dashboard…", "Composing blocks…", "Publishing public link…")
 *      so the 5–10 second round-trip feels intentional
 *   3. Done: navigates straight into the new report; if a public URL was
 *      minted, the report viewer's existing Share affordances pick it up
 *
 * The public link is off unless the builder ticks it, every time: a
 * no-sign-in URL is never a side effect (PDPA). When the table carries
 * sensitive columns the toggle says which ones before anything is shared.
 */
import { useState } from "react";
import { Sparkles, Loader2, AlertTriangle, Globe } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";

const STAGE_KEYS_PRIVATE = [
  "tableDetail.autoGen.stage.read",
  "tableDetail.autoGen.stage.design",
  "tableDetail.autoGen.stage.compose",
  "tableDetail.autoGen.stage.almost",
];
const STAGE_KEYS_PUBLIC = [
  "tableDetail.autoGen.stage.read",
  "tableDetail.autoGen.stage.design",
  "tableDetail.autoGen.stage.compose",
  "tableDetail.autoGen.stage.publish",
];

export function AutoGenerateButton({ tableName, sensitiveColumns = [] }: {
  tableName: string;
  /** Columns tagged pii / financial / health / secret in the catalog. */
  sensitiveColumns?: string[];
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [publish, setPublish] = useState(false);

  async function generate() {
    setBusy(true); setError(null); setStage(0);
    const stages = publish ? STAGE_KEYS_PUBLIC : STAGE_KEYS_PRIVATE;
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
      setError(e?.message ?? t("tableDetail.autoGen.failed"));
      setBusy(false);
    } finally {
      clearInterval(ticker);
    }
  }

  const stages = publish ? STAGE_KEYS_PUBLIC : STAGE_KEYS_PRIVATE;

  return (
    <>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={generate}
          disabled={busy}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-60"
          title={t("tableDetail.autoGen.title")}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
          {busy ? t(stages[stage]) : t("tableDetail.autoGen.button")}
        </button>
        {!busy && (
          <label
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
            title={t("tableDetail.autoGen.publicTitle")}
          >
            <input
              type="checkbox"
              checked={publish}
              onChange={(e) => setPublish(e.target.checked)}
              className="h-3.5 w-3.5 accent-primary"
            />
            <Globe className="h-3.5 w-3.5" /> {t("tableDetail.autoGen.public")}
          </label>
        )}
      </div>
      {publish && !busy && sensitiveColumns.length > 0 && (
        <span role="status" className="inline-flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-xs text-warning">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {t("tableDetail.autoGen.sensitiveWarn").replace("{cols}", sensitiveColumns.join(", "))}
        </span>
      )}
      {error && (
        <span className="inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
          <AlertTriangle className="h-3 w-3" /> {error}
        </span>
      )}
    </>
  );
}
