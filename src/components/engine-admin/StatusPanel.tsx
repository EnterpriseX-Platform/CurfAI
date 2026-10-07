"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, Loader2, MinusCircle, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/LocaleContext";
import { fill } from "@/lib/i18n/fill";
import { cn } from "@/lib/utils";
import { splitHint, statusSteps, STEP_IDS, type StepState } from "@/lib/engine/statusView";
import type { EngineAdminPanelProps } from "./types";

type Identity = { username: string; tenantId: string; roles: string[]; permissions: string[]; attributes: Record<string, string[]> };
type Status = {
  ok: boolean;
  latencyMs: number;
  source: "platform" | "workspace";
  reachable: boolean;
  acceptsIdentity: boolean;
  workspaceMatches: boolean | null;
  identity?: Identity;
  views?: number;
  problem?: string;
  hint?: string;
};

type Load = { phase: "running" } | { phase: "error"; message: string } | { phase: "done"; status: Status };

const ICON: Record<StepState, { Icon: typeof CheckCircle2; tone: string }> = {
  pass: { Icon: CheckCircle2, tone: "text-success" },
  fail: { Icon: XCircle, tone: "text-destructive" },
  attention: { Icon: AlertTriangle, tone: "text-warning" },
  skipped: { Icon: MinusCircle, tone: "text-muted-foreground" },
};

/** Copies text; says whether it worked (the clipboard can be blocked, e.g. on a page without permission). */
function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useT();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2500);
  };
  return (
    <Button type="button" size="sm" variant="outline" onClick={copy} aria-label={label}>
      <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{state === "copied" ? t("engineAdmin.status.copied") : state === "failed" ? t("engineAdmin.status.copyFailed") : t("engineAdmin.status.copy")}</span>
    </Button>
  );
}

function ListLine({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <details className="rounded-md border border-border bg-muted/40 px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {fill(title, { count: items.length })}
      </summary>
      {items.length ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {items.map((item) => (
            <li key={item} className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{item}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">{empty}</p>
      )}
    </details>
  );
}

export function StatusPanel({ dataSourceId, name }: EngineAdminPanelProps) {
  const { t } = useT();
  const [load, setLoad] = useState<Load>({ phase: "running" });
  const run = useRef(0);

  const check = useCallback(async () => {
    const mine = ++run.current;
    setLoad({ phase: "running" });
    try {
      const res = await fetch("/api/engine/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataSourceId }),
      });
      const body = await res.json().catch(() => null);
      if (mine !== run.current) return;
      if (!res.ok || !body?.status) {
        setLoad({ phase: "error", message: typeof body?.error === "string" ? body.error : `HTTP ${res.status}` });
        return;
      }
      setLoad({ phase: "done", status: body.status as Status });
    } catch (e) {
      if (mine !== run.current) return;
      setLoad({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [dataSourceId]);

  useEffect(() => {
    const counter = run;
    void check();
    // Leaving the page (or testing another engine) makes any answer still on its way stale.
    return () => { counter.current++; };
  }, [check]);

  const running = load.phase === "running";
  const status = load.phase === "done" ? load.status : null;
  const steps = status ? statusSteps(status) : null;

  const headline = running
    ? t("engineAdmin.status.running")
    : load.phase === "error"
      ? t("engineAdmin.status.errorTitle")
      : status?.ok
        ? t("engineAdmin.status.okTitle")
        : t("engineAdmin.status.failTitle");

  return (
    <div className="space-y-6">
      <section aria-labelledby="engine-status-heading" className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="engine-status-heading" className="flex items-center gap-2 text-base font-semibold text-foreground">
              {running ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
                : load.phase === "error" ? <XCircle className="h-5 w-5 text-destructive" aria-hidden="true" />
                : status?.ok ? <CheckCircle2 className="h-5 w-5 text-success" aria-hidden="true" />
                : <XCircle className="h-5 w-5 text-destructive" aria-hidden="true" />}
              {headline}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{fill(t("engineAdmin.status.intro"), { name })}</p>
          </div>
          <Button type="button" variant="outline" onClick={() => void check()} disabled={running}>
            <RefreshCw className={cn("h-4 w-4", running && "animate-spin")} aria-hidden="true" />
            {t("engineAdmin.status.testAgain")}
          </Button>
        </div>

        {/* Announced when the check finishes, so a screen-reader user hears the result without hunting for it. */}
        <div role="status" aria-live="polite" className="sr-only">{running ? t("engineAdmin.status.running") : headline}</div>

        {load.phase === "error" && (
          <div role="alert" className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-foreground">
            <p>{fill(t("engineAdmin.status.errorBody"), { error: load.message })}</p>
          </div>
        )}

        {running && (
          <ul className="mt-4 space-y-2" aria-hidden="true">
            {STEP_IDS.map((id) => (
              <li key={id} className="h-10 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
            ))}
          </ul>
        )}

        {steps && status && (
          <>
            <ol className="mt-4 divide-y divide-border rounded-md border border-border" aria-label={t("engineAdmin.status.checklist")}>
              {steps.map((step, index) => {
                const { Icon, tone } = ICON[step.state];
                const detail =
                  step.id === "reachable" && step.state === "pass" ? fill(t("engineAdmin.status.step.reachable.detail"), { ms: step.value ?? 0 })
                  : step.id === "views" && step.state === "pass" ? fill(t("engineAdmin.status.step.views.detail"), { count: step.value ?? 0 })
                  : step.id === "views" && step.state === "attention" ? t("engineAdmin.status.step.views.none")
                  : null;
                return (
                  <li key={step.id} className="flex items-center gap-3 px-3 py-2.5">
                    <Icon className={cn("h-5 w-5 shrink-0", tone)} aria-hidden="true" />
                    <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
                      {index + 1}. {t(`engineAdmin.status.step.${step.id}.name`)}
                      {detail && <span className="ml-2 font-normal text-muted-foreground">{detail}</span>}
                    </span>
                    {/* The state is written out as well as drawn: never colour alone. */}
                    <span className={cn("shrink-0 text-xs font-medium", tone)}>{t(`engineAdmin.status.state.${step.state}`)}</span>
                  </li>
                );
              })}
            </ol>

            {(status.problem || status.hint) && (
              <div role="alert" className="mt-4 space-y-3 rounded-md border border-destructive/30 bg-destructive/10 p-4">
                {status.problem && (
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("engineAdmin.status.problem")}</p>
                      <p className="mt-0.5 text-sm text-foreground">{status.problem}</p>
                    </div>
                    <CopyButton text={status.problem} label={t("engineAdmin.status.copyProblem")} />
                  </div>
                )}
                {status.hint && (
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("engineAdmin.status.hint")}</p>
                      <p className="mt-0.5 text-sm text-foreground">
                        {splitHint(status.hint).map((seg, i) =>
                          seg.code
                            ? <code key={i} className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs">{seg.text}</code>
                            : <span key={i}>{seg.text}</span>,
                        )}
                      </p>
                    </div>
                    <CopyButton text={status.hint} label={t("engineAdmin.status.copyHint")} />
                  </div>
                )}
              </div>
            )}

            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("engineAdmin.status.whereTitle")}</dt>
                <dd className="mt-0.5 text-foreground">
                  {status.source === "platform" ? t("engineAdmin.status.wherePlatform") : t("engineAdmin.status.whereWorkspace")}
                </dd>
              </div>
              {status.reachable && (
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("engineAdmin.status.latency")}</dt>
                  <dd className="mt-0.5 font-mono text-foreground">{fill(t("engineAdmin.status.latencyValue"), { ms: status.latencyMs })}</dd>
                </div>
              )}
            </dl>
          </>
        )}
      </section>

      {status?.identity && (
        <section aria-labelledby="engine-identity-heading" className="rounded-xl border border-border bg-card p-5">
          <h2 id="engine-identity-heading" className="text-base font-semibold text-foreground">{t("engineAdmin.status.identityTitle")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("engineAdmin.status.identityIntro")}</p>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("engineAdmin.status.username")}</dt>
              <dd className="mt-0.5 break-all font-mono text-foreground">{status.identity.username}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("engineAdmin.status.workspace")}</dt>
              <dd className="mt-0.5 break-all font-mono text-foreground">{status.identity.tenantId}</dd>
            </div>
          </dl>
          <div className="mt-3 space-y-2">
            <ListLine title={t("engineAdmin.status.roles")} items={status.identity.roles} empty={t("engineAdmin.status.noneListed")} />
            <ListLine title={t("engineAdmin.status.permissions")} items={status.identity.permissions} empty={t("engineAdmin.status.noneListed")} />
            <ListLine
              title={t("engineAdmin.status.attributes")}
              items={Object.entries(status.identity.attributes).map(([attr, values]) => `${attr} = ${values.join(", ")}`)}
              empty={t("engineAdmin.status.noAttributes")}
            />
          </div>
        </section>
      )}

      <section aria-labelledby="engine-explain-heading" className="rounded-xl border border-border bg-muted/40 p-5">
        <h2 id="engine-explain-heading" className="text-sm font-semibold text-foreground">{t("engineAdmin.status.explainTitle")}</h2>
        <dl className="mt-3 space-y-3 text-sm">
          {STEP_IDS.map((id) => (
            <div key={id}>
              <dt className="font-medium text-foreground">{t(`engineAdmin.status.step.${id}.name`)}</dt>
              <dd className="mt-0.5 text-muted-foreground">{t(`engineAdmin.status.step.${id}.explain`)}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
