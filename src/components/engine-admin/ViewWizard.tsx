"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Layers, Loader2 } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogIcon, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { fill } from "@/lib/engine/fill";
import type { EngineConnection, EngineProblem, EngineView, Introspection, QueryResult } from "@/lib/engine/adminClient";
import {
  VIEW_STEPS, emptyViewForm, findTable, firstInvalidStep, fromView, isDirty, mergeSaved, routeProblem, snapshot, sourceKey,
  sqlForTable, stepOfProblem, suggestViewName, syncParams, toViewRequest, validateStep, roleSuggestions,
  type RoutedProblem, type ViewErrors, type ViewForm, type ViewStep,
} from "@/lib/engine/viewForm";
import { ConfirmDialog } from "./ConfirmDialog";
import { Notice, problemText, useAdminCall } from "./adminUi";
import { AccessStep, ColumnsStep, PublicStep, ReviewStep, RowsStep, SourceStep } from "./ViewWizardSteps";

export type WizardStart = { view?: EngineView; connectionId?: string; table?: string | null };

type Intros = Record<string, Introspection | "loading" | { error: string }>;

const FIELD_IDS: Record<string, string> = { name: "view-name", connectionId: "view-connection", sql: "view-sql", refreshSeconds: "view-refresh" };

/** The guided create/edit dialog for one view. It owns the form; the engine owns every rule it is checked against. */
export function ViewWizard({ dataSourceId, connections, start, roles, attributeNames, onClose, onDone }: {
  dataSourceId: string;
  connections: EngineConnection[];
  start: WizardStart;
  roles: { slug: string; label?: string }[];
  attributeNames: string[];
  /** `changed`: something reached the engine (a draft was created or saved), so the list needs reloading. */
  onClose: (changed: boolean) => void;
  onDone: (message: string) => void;
}) {
  const { t } = useT();
  const call = useAdminCall(dataSourceId);

  // The starting point is read once, when the dialog opens.
  const [initial] = useState<ViewForm>(() => {
    if (start.view) {
      const f = fromView(start.view);
      return { ...f, sampleParams: syncParams(f.sql, []) };
    }
    return emptyViewForm(start.connectionId ?? "");
  });

  const [form, setForm] = useState<ViewForm>(initial);
  const [baseline, setBaseline] = useState(() => snapshot(initial));
  const [savedSource, setSavedSource] = useState(() => (start.view ? sourceKey(initial) : ""));
  const [step, setStep] = useState<ViewStep>("source");
  const [errors, setErrors] = useState<ViewErrors>({});
  const [routed, setRouted] = useState<RoutedProblem | null>(null);
  const [general, setGeneral] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  /** The question on screen, if any: leaving with unsaved changes, or publishing a view to the public. */
  const [ask, setAsk] = useState<null | "discard" | "public">(null);
  const [busy, setBusy] = useState<null | "read" | "save" | "publish" | "preview">(null);
  const [intros, setIntros] = useState<Intros>({});
  const [preview, setPreview] = useState<QueryResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const changed = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);

  const editing = Boolean(form.id);
  const dirty = isDirty(form, baseline);
  const connection = connections.find((c) => c.id === form.connectionId);
  const roleOptions = useMemo(() => roleSuggestions(roles), [roles]);

  // Move to the step's heading when the step changes, so a keyboard or screen-reader user lands on it.
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    heading.current?.focus();
  }, [step]);

  const patch = useCallback((change: Partial<ViewForm>) => {
    setForm((f) => ({ ...f, ...change }));
    setErrors({});
    setPreview(null);
  }, []);

  const cache = useRef<Record<string, Introspection>>({});
  const loadIntro = useCallback(async (connectionId: string): Promise<Introspection | null> => {
    if (!connectionId) return null;
    if (cache.current[connectionId]) return cache.current[connectionId];
    setIntros((s) => ({ ...s, [connectionId]: "loading" }));
    const res = await call<Introspection>("POST", `/connections/${connectionId}/introspect`);
    if (res.ok) cache.current[connectionId] = res.data;
    setIntros((s) => ({
      ...s,
      [connectionId]: res.ok ? res.data : { error: problemText(res.problem, t("engineAdmin.views.source.tablesFailed"), t("engineAdmin.views.err.unreachable")) },
    }));
    return res.ok ? res.data : null;
  }, [call, t]);

  const applyTable = useCallback((found: { schema: string; table: Introspection["schemas"][number]["tables"][number] }, kindOf: EngineConnection | undefined) => {
    const sql = sqlForTable(kindOf?.kind ?? "POSTGRESQL", found.schema, found.table);
    setForm((f) => ({ ...f, sql, name: f.name.trim() ? f.name : suggestViewName(found.table.name), sampleParams: [] }));
  }, []);

  // Arriving from "Create a view from this table" on the Databases tab.
  useEffect(() => {
    const table = start.table;
    if (!table || !start.connectionId || start.view) return;
    let live = true;
    void (async () => {
      const intro = await loadIntro(start.connectionId!);
      if (!live || !intro) return;
      const found = findTable(intro, table);
      if (found) applyTable(found, connections.find((c) => c.id === start.connectionId));
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickTable = (schema: string, name: string) => {
    const intro = intros[form.connectionId];
    if (!intro || typeof intro !== "object" || !("schemas" in intro)) return;
    const found = findTable(intro, schema ? `${schema}.${name}` : name);
    if (found) { applyTable(found, connection); setErrors({}); }
  };

  const requestClose = () => {
    if (busy) return;
    if (dirty) { setAsk("discard"); return; }
    onClose(changed.current);
  };

  const showProblem = (problem: EngineProblem) => {
    if (problem.stale) { setStale(true); setGeneral(null); return; }
    const r = routeProblem(problem);
    setRouted(r);
    const target = stepOfProblem(r);
    if (target) setStep(target);
    const loose = r.general.join(" ");
    setGeneral(problem.unreachable || (!target && !loose)
      ? problemText(problem, t("engineAdmin.views.err.saveFailed"), t("engineAdmin.views.err.unreachable"))
      : loose || null);
  };

  const focusFirst = (errs: ViewErrors) => {
    const key = Object.keys(errs)[0];
    const id = FIELD_IDS[key] ?? (key.startsWith("rule.") ? `rule-${key.split(".")[1]}-${key.split(".")[2]}` : key === "publicAck" ? "view-public-ack" : null);
    if (id) window.setTimeout(() => document.getElementById(id)?.focus(), 0);
  };

  /** Sends the working copy to the engine. `sourceChanged`: the statement moved, so the engine re-reads the columns without our overrides. */
  const persist = async (sourceChanged = false): Promise<EngineView | null> => {
    setRouted(null);
    setGeneral(null);
    const res = await call<EngineView>(form.id ? "PUT" : "POST", form.id ? `/views/${form.id}` : "/views", {
      body: toViewRequest(form, { omitColumns: sourceChanged || !form.id }),
    });
    if (!res.ok) { showProblem(res.problem); return null; }
    changed.current = true;
    const next = mergeSaved(form, res.data, { keepChoices: sourceChanged });
    setForm(next);
    setBaseline(snapshot(next));
    setSavedSource(sourceKey(next));
    return res.data;
  };

  const next = async () => {
    const errs = validateStep(form, step);
    if (Object.keys(errs).length) { setErrors(errs); focusFirst(errs); return; }
    const at = VIEW_STEPS.indexOf(step);
    if (step === "source" && (!form.id || sourceKey(form) !== savedSource)) {
      setBusy("read");
      const saved = await persist(Boolean(form.id));
      setBusy(null);
      if (!saved) return;
    }
    setErrors({});
    setStep(VIEW_STEPS[Math.min(at + 1, VIEW_STEPS.length - 1)]);
  };

  const back = () => { setErrors({}); setStep(VIEW_STEPS[Math.max(VIEW_STEPS.indexOf(step) - 1, 0)]); };

  const goTo = (target: ViewStep) => {
    if (!form.id && target !== "source") return;
    setErrors({});
    setStep(target);
  };

  /** Every step's checks, in order; stops at the first with a problem and takes the admin there. */
  const checkAll = (): boolean => {
    const bad = firstInvalidStep(form);
    if (!bad) return true;
    setStep(bad.step);
    setErrors(bad.errors);
    focusFirst(bad.errors);
    return false;
  };

  const doSave = async (alsoPublish: boolean, confirmedPublic = false) => {
    if (!checkAll()) return;
    if (alsoPublish && form.isPublic && !confirmedPublic) { setAsk("public"); return; }
    setBusy(alsoPublish ? "publish" : "save");
    // The statement is saved with the columns step; here only the policy and labels move.
    const saved = await persist(sourceKey(form) !== savedSource);
    if (!saved) { setBusy(null); return; }
    if (alsoPublish) {
      const res = await call<EngineView>("POST", `/views/${saved.id}/publish`);
      if (!res.ok) {
        setBusy(null);
        setStep("review");
        setGeneral(`${t("engineAdmin.views.wizard.publishFailed")} ${problemText(res.problem, "", t("engineAdmin.views.err.unreachable"))}`.trim());
        return;
      }
    }
    setBusy(null);
    onDone(fill(t(alsoPublish ? "engineAdmin.views.notice.published" : "engineAdmin.views.notice.savedDraft"), { name: form.name.trim() }));
  };

  const runPreview = async () => {
    setPreviewError(null);
    if (!checkAll()) return;
    setBusy("preview");
    const saved = dirty || !form.id ? await persist(sourceKey(form) !== savedSource) : { id: form.id };
    if (!saved) { setBusy(null); return; }
    const res = await call<QueryResult>("POST", `/views/${saved.id}/preview`, { body: {} });
    setBusy(null);
    if (res.ok) setPreview(res.data);
    else setPreviewError(problemText(res.problem, t("engineAdmin.views.review.previewFailed"), t("engineAdmin.views.err.unreachable")));
  };

  const reloadTheirs = async () => {
    if (!form.id) return;
    const res = await call<EngineView>("GET", `/views/${form.id}`);
    if (!res.ok) { setGeneral(problemText(res.problem, t("engineAdmin.views.err.loadFailed"), t("engineAdmin.views.err.unreachable"))); return; }
    const f = fromView(res.data);
    const fresh = { ...f, sampleParams: syncParams(f.sql, []) };
    setForm(fresh);
    setBaseline(snapshot(fresh));
    setSavedSource(sourceKey(fresh));
    setStale(false);
    setRouted(null);
    setErrors({});
    changed.current = true;
  };

  const stepLabel = (s: ViewStep) => t(`engineAdmin.views.step.${s}`);
  const at = VIEW_STEPS.indexOf(step);
  const last = step === "review";
  const messages = routed?.byStep[step];

  return (
    <>
    <Dialog open onOpenChange={(open) => { if (!open && !ask) requestClose(); }}>
      <DialogContent className="max-w-4xl" aria-describedby="wizard-desc">
        <DialogHeader>
          <DialogIcon><Layers className="h-4 w-4" aria-hidden="true" /></DialogIcon>
          <div>
            <DialogTitle>{editing && start.view ? fill(t("engineAdmin.views.wizard.editTitle"), { name: start.view.name }) : t("engineAdmin.views.wizard.newTitle")}</DialogTitle>
            <DialogDescription id="wizard-desc">{t("engineAdmin.views.wizard.intro")}</DialogDescription>
          </div>
        </DialogHeader>

        <nav aria-label={t("engineAdmin.views.wizard.steps")} className="border-b border-border px-5 py-3">
          <ol className="flex flex-wrap gap-x-1 gap-y-1">
            {VIEW_STEPS.map((s, i) => {
              const reachable = editing || s === "source";
              const current = s === step;
              const done = i < at;
              return (
                <li key={s}>
                  <button
                    type="button"
                    onClick={() => goTo(s)}
                    disabled={!reachable}
                    aria-current={current ? "step" : undefined}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
                      current ? "bg-primary-soft text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <span className={cn("flex h-5 w-5 items-center justify-center rounded-full text-[11px]", current ? "bg-primary text-primary-foreground" : done ? "bg-success/15 text-success" : "bg-muted")} aria-hidden="true">
                      {done ? <Check className="h-3 w-3" /> : i + 1}
                    </span>
                    {stepLabel(s)}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <DialogBody>
          {stale && (
            <Notice tone="warning" title={t("engineAdmin.views.stale.title")}>
              <p>{t("engineAdmin.views.stale.body")}</p>
              <Button type="button" size="sm" variant="outline" onClick={reloadTheirs}>{t("engineAdmin.views.stale.reload")}</Button>
            </Notice>
          )}
          {general && step !== "review" && <Notice tone="danger">{general}</Notice>}

          <h3 ref={heading} tabIndex={-1} className="text-sm font-semibold focus:outline-none">
            {fill(t("engineAdmin.views.wizard.stepOf"), { n: at + 1, total: VIEW_STEPS.length, name: stepLabel(step) })}
          </h3>

          {step === "source" && <SourceStep form={form} patch={patch} errors={errors} engineMessages={messages} connections={connections} intros={intros} loadIntro={(id) => void loadIntro(id)} onPickTable={pickTable} />}
          {step === "columns" && <ColumnsStep form={form} patch={patch} errors={errors} engineMessages={messages} />}
          {step === "access" && <AccessStep form={form} patch={patch} errors={errors} engineMessages={messages} roles={roleOptions} />}
          {step === "rows" && <RowsStep form={form} patch={patch} errors={errors} engineMessages={messages} attributeNames={attributeNames} />}
          {step === "public" && <PublicStep form={form} patch={patch} errors={errors} refusals={routed?.publicRefusals ?? []} goToStep={goTo} />}
          {step === "review" && (
            <ReviewStep form={form} connection={connection} dirty={dirty} preview={preview} previewing={busy === "preview"} previewError={previewError} onPreview={runPreview} goToStep={goTo} general={general} />
          )}
        </DialogBody>

        <DialogFooter className="justify-between">
          <Button type="button" variant="ghost" onClick={back} disabled={at === 0 || busy !== null}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> {t("engineAdmin.views.wizard.back")}
          </Button>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="ghost" onClick={requestClose} disabled={busy !== null}>{t("engineAdmin.views.wizard.cancel")}</Button>
            {editing && (
              <Button type="button" variant="outline" onClick={() => void doSave(false)} disabled={busy !== null}>
                {busy === "save" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                {t("engineAdmin.views.wizard.saveDraft")}
              </Button>
            )}
            {last ? (
              <Button type="button" onClick={() => void doSave(true)} disabled={busy !== null}>
                {busy === "publish" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                {t("engineAdmin.views.wizard.saveAndPublish")}
              </Button>
            ) : (
              <Button type="button" onClick={() => void next()} disabled={busy !== null}>
                {busy === "read" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                {step === "source" && (!form.id || sourceKey(form) !== savedSource) ? t("engineAdmin.views.wizard.readColumns") : t("engineAdmin.views.wizard.next")}
                {busy === "read" ? null : <ArrowRight className="h-4 w-4" aria-hidden="true" />}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {ask === "discard" && (
      <ConfirmDialog
        title={t("engineAdmin.views.wizard.discard")}
        confirmLabel={t("engineAdmin.confirm.discardAction")}
        cancelLabel={t("engineAdmin.confirm.keepEditing")}
        destructive
        onConfirm={() => { setAsk(null); onClose(changed.current); }}
        onCancel={() => setAsk(null)}
      />
    )}
    {ask === "public" && (
      <ConfirmDialog
        title={t("engineAdmin.confirm.publicTitle")}
        message={t("engineAdmin.views.wizard.confirmPublic")}
        confirmLabel={t("engineAdmin.views.wizard.saveAndPublish")}
        cancelLabel={t("engineAdmin.views.wizard.cancel")}
        onConfirm={() => { setAsk(null); void doSave(true, true); }}
        onCancel={() => setAsk(null)}
      />
    )}
    </>
  );
}
