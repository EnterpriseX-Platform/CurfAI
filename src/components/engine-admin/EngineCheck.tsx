"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, SearchCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/LocaleContext";
import { fill } from "@/lib/i18n/fill";
import { driftExamples, driftState, syncWouldHelp, type DriftEngine, type DriftExample, type Member, type SyncResult } from "@/lib/engine/attributeView";
import { engineApi } from "./peopleApi";

type Phase = { name: "idle" } | { name: "checking" } | { name: "error"; error: string } | { name: "done"; engines: DriftEngine[] };

function Examples({ title, rows, count }: { title: string; rows: DriftExample[]; count: number }) {
  const { t } = useT();
  if (rows.length === 0) return null;
  return (
    <div className="mt-2">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <ul className="mt-1 space-y-0.5 font-mono text-xs text-foreground">
        {rows.map((r, i) => (
          <li key={`${r.who}-${r.attribute}-${r.value}-${i}`} className="break-all">{fill(t("engineAdmin.people.check.exampleRow"), r)}</li>
        ))}
      </ul>
      {count > rows.length && <p className="mt-1 text-xs text-muted-foreground">{fill(t("engineAdmin.people.check.exampleMore"), { count: count - rows.length })}</p>}
    </div>
  );
}

/** Compares what Curf holds with what each engine holds, shows the differences in plain words, and can fix them. */
export function EngineCheck({ members, onSynced }: { members: Member[]; onSynced: () => void }) {
  const { t } = useT();
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult[] | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const check = async () => {
    setPhase({ name: "checking" });
    const res = await engineApi<{ engines: DriftEngine[] }>("GET", "/api/engine/attributes/drift");
    setPhase(res.ok ? { name: "done", engines: res.data.engines ?? [] } : { name: "error", error: res.error });
  };

  const sync = async () => {
    setSyncing(true);
    setSyncResult(null);
    setSyncError(null);
    const res = await engineApi<{ engines: SyncResult[] }>("POST", "/api/engine/attributes/sync");
    setSyncing(false);
    if (!res.ok) { setSyncError(res.error); return; }
    setSyncResult(res.data.engines ?? []);
    onSynced();
    await check();
  };

  const engines = phase.name === "done" ? phase.engines : [];
  const busy = phase.name === "checking" || syncing;

  return (
    <section aria-labelledby="people-check-heading" className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="people-check-heading" className="flex items-center gap-2 text-base font-semibold text-foreground">
            <SearchCheck className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            {t("engineAdmin.people.check.title")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("engineAdmin.people.check.intro")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => void check()} disabled={busy}>
            {phase.name === "checking" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <SearchCheck className="h-4 w-4" aria-hidden="true" />}
            {phase.name === "checking" ? t("engineAdmin.people.check.checking") : phase.name === "done" ? t("engineAdmin.people.check.again") : t("engineAdmin.people.check.run")}
          </Button>
          {phase.name === "done" && syncWouldHelp(engines) && (
            <Button type="button" onClick={() => void sync()} disabled={busy}>
              <RefreshCw className={syncing ? "h-4 w-4 animate-spin" : "h-4 w-4"} aria-hidden="true" />
              {syncing ? t("engineAdmin.people.check.syncing") : t("engineAdmin.people.check.sync")}
            </Button>
          )}
        </div>
      </div>

      <div role="status" aria-live="polite" className="mt-3 space-y-3">
        {phase.name === "error" && (
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-foreground">
            {fill(t("engineAdmin.people.check.failed"), { error: phase.error })}
          </p>
        )}
        {syncError && (
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-foreground">
            {fill(t("engineAdmin.people.check.syncFailed"), { error: syncError })}
          </p>
        )}
        {syncResult && (
          <ul className="space-y-1">
            {syncResult.map((s) => (
              <li key={s.dataSourceId} className="flex items-start gap-2 text-sm text-foreground">
                {s.ok
                  ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                  : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />}
                <span>{s.ok
                  ? fill(t("engineAdmin.people.check.syncOk"), { engine: s.name, entries: s.entries ?? 0 })
                  : fill(t("engineAdmin.people.check.syncEngineFailed"), { engine: s.name, error: s.error ?? t("engineAdmin.people.result.unknownError") })}</span>
              </li>
            ))}
          </ul>
        )}
        {phase.name === "done" && engines.length === 0 && <p className="text-sm text-muted-foreground">{t("engineAdmin.people.check.noEngines")}</p>}
      </div>

      {engines.length > 0 && (
        <ul className="mt-3 space-y-3">
          {engines.map((e) => {
            const state = driftState(e);
            const missing = e.missingOnEngine ?? 0;
            const extra = e.extraOnEngine ?? 0;
            const Icon = state === "inSync" ? CheckCircle2 : state === "unreachable" ? XCircle : AlertTriangle;
            const tone = state === "inSync" ? "text-success" : state === "unreachable" ? "text-destructive" : "text-warning";
            return (
              <li key={e.dataSourceId} className="rounded-md border border-border p-4">
                <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Icon className={`h-4 w-4 shrink-0 ${tone}`} aria-hidden="true" />
                  <span>{e.name}</span>
                  <span className={`text-xs ${tone}`}>{t(`engineAdmin.people.check.state.${state}`)}</span>
                </p>
                {state === "unreachable" && (
                  <p className="mt-1 text-sm text-muted-foreground">{fill(t("engineAdmin.people.check.unreachable"), { error: e.error ?? t("engineAdmin.people.result.unknownError") })}</p>
                )}
                {state === "inSync" && <p className="mt-1 text-sm text-muted-foreground">{t("engineAdmin.people.check.inSyncBody")}</p>}
                {e.ok && e.complete === false && <p className="mt-1 text-sm text-muted-foreground">{t("engineAdmin.people.check.incomplete")}</p>}
                {extra > 0 && (
                  <div className="mt-3 rounded-md border border-warning/40 bg-warning/10 p-3">
                    <p className="text-sm font-medium text-foreground">{fill(t("engineAdmin.people.check.extraTitle"), { count: extra.toLocaleString() })}</p>
                    <p className="mt-0.5 text-sm text-foreground">{t("engineAdmin.people.check.extraBody")}</p>
                    <Examples title={t("engineAdmin.people.check.examples")} rows={driftExamples(e.examples?.extraOnEngine, members)} count={extra} />
                  </div>
                )}
                {missing > 0 && (
                  <div className="mt-3 rounded-md border border-border bg-muted/40 p-3">
                    <p className="text-sm font-medium text-foreground">{fill(t("engineAdmin.people.check.missingTitle"), { count: missing.toLocaleString() })}</p>
                    <p className="mt-0.5 text-sm text-muted-foreground">{t("engineAdmin.people.check.missingBody")}</p>
                    <Examples title={t("engineAdmin.people.check.examples")} rows={driftExamples(e.examples?.missingOnEngine, members)} count={missing} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
