"use client";
/**
 * The retail reports card on the Tables page. Appears once a sales or stock
 * file has been imported into the standard tables: sets up the branch
 * overview, sales insights, stock & reorder and sales plan reports (and the low-stock /
 * slow-mover watchers) from that data, then links to them.
 *
 * Setup runs again whenever the data supports a report that isn't there
 * yet — a stock file imported after the sales, say — and only adds what's
 * missing (POST /api/lake/retail).
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Store, Loader2, ArrowRight, RefreshCw, AlertTriangle } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";

type Status = { hasSales: boolean; hasStock: boolean; reports: Array<{ id: string; name: string }>; expected: number };
type Summary = { reportsCreated: number; watchersCreated: number; errors: string[]; pinned: number };

// Stable English report names (lib/templates/retail/pack.ts) → their label here.
const REPORT_LABELS: Record<string, string> = {
  "Retail · Branch overview": "tables.retail.report.overview",
  "Retail · Sales insights": "tables.retail.report.insights",
  "Retail · Stock & reorder": "tables.retail.report.stock",
  "Retail · Sales plan": "tables.retail.report.plan",
  "Retail · Basket & promotions": "tables.retail.report.basket",
  "Retail · Menu profitability": "tables.retail.report.menu",
};

export function RetailPackCard({ dataKey, canSetUp }: {
  /** Changes when the standard tables do, so the card re-reads its status after an import. */
  dataKey: string;
  canSetUp: boolean;
}) {
  const { t } = useT();
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<"setup" | "refresh" | null>(null);
  const [done, setDone] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/lake/retail", { cache: "no-store", credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j) setStatus(j); })
      .catch(() => null);
    return () => { live = false; };
  }, [dataKey]);

  if (!status || (!status.hasSales && !status.hasStock)) return null;

  // What the data supports (the server works it out: menu analysis needs costs, say).
  const missing = status.reports.length < status.expected;

  async function run(action: "setup" | "refresh") {
    setBusy(action);
    setError(null);
    setDone(null);
    try {
      const r = await fetch("/api/lake/retail", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      if (j.status) setStatus(j.status);
      if (action === "setup") setDone({ ...j.summary, pinned: j.pinned ?? 0 });
      router.refresh();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-5 shadow-xs">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:gap-6">
        <div className="flex items-start gap-3 md:flex-1">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
            <Store className="h-5 w-5" />
          </span>
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">{t("tables.retail.heading")}</h2>
            <p className="text-[11px] text-muted-foreground">
              {missing ? t("tables.retail.subtext") : t("tables.retail.subtextReady")}
            </p>
            {status.reports.length > 0 && (
              <ul className="flex flex-wrap gap-2 pt-1">
                {status.reports.map((r) => (
                  <li key={r.id}>
                    <Link
                      href={`/reports/${r.id}`}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs hover:bg-muted"
                    >
                      {REPORT_LABELS[r.name] ? t(REPORT_LABELS[r.name]) : r.name}
                      <ArrowRight className="h-3 w-3" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {canSetUp && (
          <div className="flex items-center gap-2">
            {status.reports.length > 0 && (
              <button
                type="button"
                onClick={() => void run("refresh")}
                disabled={busy !== null}
                className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-xs hover:bg-muted disabled:opacity-50"
              >
                {busy === "refresh" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                {t("tables.retail.refresh")}
              </button>
            )}
            {missing && (
              <button
                type="button"
                onClick={() => void run("setup")}
                disabled={busy !== null}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {busy === "setup" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {status.reports.length > 0 ? t("tables.retail.addMissing") : t("tables.retail.setUp")}
              </button>
            )}
          </div>
        )}
      </div>

      {done && (
        <p className="mt-3 text-xs text-muted-foreground" role="status">
          {t(done.pinned > 0 ? "tables.retail.done" : "tables.retail.doneNoPins")
            .replace("{reports}", String(done.reportsCreated))
            .replace("{watchers}", String(done.watchersCreated))
            .replace("{pins}", String(done.pinned))}
        </p>
      )}
      {(error || (done && done.errors.length > 0)) && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-destructive" role="alert">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error ?? done!.errors.join(" · ")}</span>
        </p>
      )}
    </section>
  );
}
