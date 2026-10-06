"use client";
/**
 * TypedConversionSection — E1b Phase D4 (E1B_PHASE_D_SCOPING_PLAN.md).
 *
 * The admin-facing half of "convert an existing table's text columns into
 * real typed ones". A button in the Manage panel opens a dialog (list-shaped
 * per-column review belongs in a dialog from a row, not stacked into the
 * settings panel) that:
 *
 *   1. fetches the read-only preview — a full scan, done only when the admin
 *      actually asks for it, never on page load;
 *   2. shows, per column, exactly how many values would be lost and a few
 *      examples, and says plainly what the loss IS (a number/date that can't
 *      be read becomes empty; a boolean that isn't "true"/"false" becomes
 *      false — different outcomes, different words);
 *   3. requires an explicit acknowledgement before applying whenever
 *      anything would be lost;
 *   4. sends the counts it displayed back to the server as `confirmedLossy`,
 *      and the server refuses (409 `drift`) if the data has moved since — in
 *      which case this refreshes the preview and asks again rather than
 *      applying something the admin never saw.
 *
 * Only rendered for admins on a deployment with typed columns on (the page
 * passes that down), so the client never has to do a full-table scan just to
 * decide whether to show a button.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/LocaleContext";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, AlertTriangle, Check, RefreshCw } from "lucide-react";

type ProposedType = "number" | "boolean" | "date";
type EligibleColumn = {
  name: string;
  proposedType: ProposedType;
  lossyCells: number;
  consideredCells: number;
  sampleLossyValues: string[];
};
type Preview = {
  totalRows: number;
  eligibleColumns: EligibleColumn[];
  skippedColumns: Array<{ name: string; reason: string }>;
};
type Result = { convertedColumns: string[]; skippedColumns: string[]; lossyCells: number };
type Phase = "loading" | "review" | "applying" | "done";

const TYPE_KEY: Record<ProposedType, string> = {
  number: "tableManage.typedConv.type.number",
  boolean: "tableManage.typedConv.type.boolean",
  date: "tableManage.typedConv.type.date",
};
const LOSS_KEY: Record<ProposedType, string> = {
  number: "tableManage.typedConv.loss.number",
  boolean: "tableManage.typedConv.loss.boolean",
  date: "tableManage.typedConv.loss.date",
};
const MAX_EXAMPLES = 5;
const trunc = (s: string, n = 28) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function TypedConversionSection({
  tableName,
  onConverted,
}: {
  tableName: string;
  /** Called with the server's freshly persisted schema so the page's copy stays in step. */
  onConverted: (schema: any[]) => void;
}) {
  const { t } = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("loading");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const url = `/api/lake/tables/${encodeURIComponent(tableName)}/typed-conversion`;

  async function loadPreview(keep?: Set<string>) {
    setPhase("loading"); setError(null);
    try {
      const r = await fetch(url, { credentials: "include" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error ?? `Server returned ${r.status}`);
      const p: Preview = j.preview;
      setPreview(p);
      // Keep the admin's earlier picks where the column still qualifies;
      // otherwise start with everything selected.
      setSelected(new Set(
        p.eligibleColumns.filter((c) => (keep ? keep.has(c.name) : true)).map((c) => c.name),
      ));
      setAck(false);
      setPhase("review");
    } catch (e: any) {
      setError(e?.message ?? t("tableManage.typedConv.failedFallback"));
      setPhase("review");
    }
  }

  function openDialog() {
    setOpen(true); setNotice(null); setResult(null); setPreview(null);
    void loadPreview();
  }

  const eligible = preview?.eligibleColumns ?? [];
  const chosen = eligible.filter((c) => selected.has(c.name));
  const totalLossy = chosen.reduce((n, c) => n + c.lossyCells, 0);
  const canApply = phase === "review" && chosen.length > 0 && (totalLossy === 0 || ack);

  async function apply() {
    if (!canApply) return;
    setPhase("applying"); setError(null); setNotice(null);
    try {
      const r = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        // The counts THIS dialog showed — the server aborts unless the
        // conversion would lose exactly these.
        body: JSON.stringify({
          columns: chosen.map((c) => c.name),
          confirmedLossy: Object.fromEntries(chosen.map((c) => [c.name, c.lossyCells])),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setResult(j.result);
        onConverted(j.schema);
        router.refresh();
        setPhase("done");
        return;
      }
      if (r.status === 409 && j?.code === "drift") {
        await loadPreview(selected);
        setNotice(t("tableManage.typedConv.drift"));
        return;
      }
      setError(j?.error ?? t("tableManage.typedConv.failedFallback"));
      setPhase("review");
    } catch (e: any) {
      setError(e?.message ?? t("tableManage.typedConv.failedFallback"));
      setPhase("review");
    }
  }

  function toggle(name: string) {
    setAck(false); // a different selection is a different thing to have agreed to
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  const fill = (key: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), t(key));

  return (
    <div className="rounded-md border border-border bg-background p-3">
      <header className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold">
          <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" /> {t("tableManage.typedConv.heading")}
        </h3>
        <button
          type="button"
          onClick={openDialog}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2.5 text-xs transition-colors hover:bg-muted"
        >
          {t("tableManage.typedConv.review")}
        </button>
      </header>
      <p className="mt-1 text-[11px] text-muted-foreground">{t("tableManage.typedConv.hint")}</p>

      <Dialog open={open} onOpenChange={(o) => { if (phase !== "applying") setOpen(o); }}>
        <DialogContent className="sm:max-w-xl" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t("tableManage.typedConv.dialogTitle")}</DialogTitle>
            {/* "Nothing changes until you confirm" stops being true the moment
                it has — don't leave it under a success message. */}
            {phase !== "done" && <DialogDescription>{t("tableManage.typedConv.dialogDesc")}</DialogDescription>}
          </DialogHeader>

          <div className="max-h-[60vh] space-y-3 overflow-y-auto px-1 py-1 text-xs">
            {notice && (
              <div className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-warning">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> <span>{notice}</span>
              </div>
            )}
            {error && (
              <div className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> <span>{error}</span>
              </div>
            )}

            {(phase === "loading" || phase === "applying") && (
              <div className="flex items-center gap-2 py-6 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {phase === "loading" ? t("tableManage.typedConv.loading") : t("tableManage.typedConv.applying")}
              </div>
            )}

            {phase === "done" && result && (
              <div className="space-y-2">
                <div className="flex items-start gap-1.5 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-success">
                  <Check className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>{fill("tableManage.typedConv.done", { n: result.convertedColumns.length, lost: result.lossyCells })}</span>
                </div>
                {result.skippedColumns.length > 0 && (
                  <p className="text-muted-foreground">
                    {fill("tableManage.typedConv.notConverted", { names: result.skippedColumns.join(", ") })}
                  </p>
                )}
              </div>
            )}

            {phase === "review" && preview && (
              <>
                {eligible.length === 0 ? (
                  <p className="py-2 text-muted-foreground">{t("tableManage.typedConv.nothing")}</p>
                ) : (
                  <ul className="space-y-2">
                    {eligible.map((c) => {
                      const checked = selected.has(c.name);
                      return (
                        <li key={c.name} className="rounded-md border border-border p-2.5">
                          <label className="flex cursor-pointer items-start gap-2">
                            <input
                              type="checkbox"
                              className="mt-0.5 accent-primary"
                              checked={checked}
                              onChange={() => toggle(c.name)}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex flex-wrap items-center gap-1.5">
                                <code className="font-mono text-[11px] font-semibold">{c.name}</code>
                                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                  {t(TYPE_KEY[c.proposedType])}
                                </span>
                              </span>
                              {c.lossyCells === 0 ? (
                                <span className="mt-1 block text-muted-foreground">{t("tableManage.typedConv.lossNone")}</span>
                              ) : (
                                <span className="mt-1 block text-warning">
                                  {fill(LOSS_KEY[c.proposedType], { n: c.lossyCells, total: c.consideredCells })}
                                </span>
                              )}
                              {c.lossyCells > 0 && c.sampleLossyValues.length > 0 && (
                                <span className="mt-1 flex flex-wrap items-center gap-1 text-muted-foreground">
                                  {t("tableManage.typedConv.examples")}
                                  {c.sampleLossyValues.slice(0, MAX_EXAMPLES).map((v, i) => (
                                    <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">{trunc(v)}</code>
                                  ))}
                                </span>
                              )}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}

                {preview.skippedColumns.length > 0 && (
                  <details className="text-muted-foreground">
                    <summary className="cursor-pointer select-none">{t("tableManage.typedConv.whyNot")}</summary>
                    <ul className="mt-1.5 space-y-1 pl-3">
                      {preview.skippedColumns.map((s) => (
                        <li key={s.name}><code className="font-mono text-[10px]">{s.name}</code> — {s.reason}</li>
                      ))}
                    </ul>
                  </details>
                )}

                {chosen.length > 0 && (
                  <div className="space-y-2 border-t border-border pt-3">
                    <p className={totalLossy > 0 ? "font-medium text-warning" : "text-muted-foreground"}>
                      {totalLossy > 0
                        ? fill("tableManage.typedConv.summary", { n: totalLossy, cols: chosen.filter((c) => c.lossyCells > 0).length })
                        : t("tableManage.typedConv.summaryNone")}
                    </p>
                    {totalLossy > 0 && (
                      <label className="flex cursor-pointer items-start gap-2">
                        <input type="checkbox" className="mt-0.5 accent-primary" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                        <span>{t("tableManage.typedConv.ack")}</span>
                      </label>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          <DialogFooter>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={phase === "applying"}
              className="inline-flex h-8 items-center rounded-md border border-border bg-background px-3 text-xs hover:bg-muted disabled:opacity-50"
            >
              {phase === "done" || (phase === "review" && eligible.length === 0) ? t("action.close") : t("action.cancel")}
            </button>
            {phase !== "done" && eligible.length > 0 && (
              <button
                type="button"
                onClick={apply}
                disabled={!canApply}
                className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                {phase === "applying" && <Loader2 className="h-3 w-3 animate-spin" />}
                {fill("tableManage.typedConv.apply", { n: chosen.length })}
              </button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
