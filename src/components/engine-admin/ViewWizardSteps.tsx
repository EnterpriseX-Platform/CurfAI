"use client";

/**
 * The six steps of the view dialog. Each is a plain form over the ViewForm (src/lib/engine/viewForm.ts), which holds
 * every rule; these only show it and say what each choice means in words an administrator can act on.
 */
import { useState } from "react";
import { Eye, Globe, Loader2, Plus, ShieldCheck, Table2, Trash2 } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { fill } from "@/lib/engine/fill";
import type { EngineConnection, Introspection, PiiMode, QueryResult, RlsOperator } from "@/lib/engine/adminClient";
import {
  isPersonalLooking, formatCell, publicBlockers, resetToSuggestions, syncParams,
  type RoleSuggestion, type ViewErrors, type ViewForm, type ViewStep,
} from "@/lib/engine/viewForm";
import { kindLabel } from "@/lib/engine/connectionForm";
import { Chip, Field, NativeSelect, Notice, ResultTable } from "./adminUi";
import { RoleChips } from "./RoleChips";
import { SchemaTablePicker } from "./SchemaTablePicker";

type StepProps = {
  form: ViewForm;
  patch: (change: Partial<ViewForm>) => void;
  errors: ViewErrors;
  /** The engine's own messages for this step, shown as it said them. */
  engineMessages?: string[];
};

function EngineMessages({ messages }: { messages?: string[] }) {
  const { t } = useT();
  if (!messages?.length) return null;
  return (
    <Notice tone="danger" title={t("engineAdmin.views.engineSaid")}>
      <ul className="list-disc space-y-0.5 pl-4">{messages.map((m, i) => <li key={i}>{m}</li>)}</ul>
    </Notice>
  );
}

// ---- 1. Source -------------------------------------------------------------------------------------------------------

export function SourceStep({ form, patch, errors, engineMessages, connections, intros, loadIntro, onPickTable }: StepProps & {
  connections: EngineConnection[];
  intros: Record<string, Introspection | "loading" | { error: string }>;
  loadIntro: (connectionId: string) => void;
  onPickTable: (schema: string, table: string) => void;
}) {
  const { t } = useT();
  const [picking, setPicking] = useState(false);
  const intro = form.connectionId ? intros[form.connectionId] : undefined;
  const loaded = intro && typeof intro === "object" && "schemas" in intro ? intro : null;

  return (
    <div className="space-y-4">
      <EngineMessages messages={engineMessages} />
      <Field id="view-name" label={t("engineAdmin.views.source.name")} hint={t("engineAdmin.views.source.nameHint")} error={errors.name ? t(errors.name) : undefined} required>
        {(a) => <Input {...a} value={form.name} maxLength={100} onChange={(e) => patch({ name: e.target.value })} autoComplete="off" />}
      </Field>
      <Field id="view-description" label={t("engineAdmin.views.source.description")} hint={t("engineAdmin.views.source.descriptionHint")}>
        {(a) => <Input {...a} value={form.description} onChange={(e) => patch({ description: e.target.value })} autoComplete="off" />}
      </Field>
      <Field id="view-connection" label={t("engineAdmin.views.source.connection")} hint={t("engineAdmin.views.source.connectionHint")} error={errors.connectionId ? t(errors.connectionId) : undefined} required>
        {(a) => (
          <NativeSelect {...a} value={form.connectionId} onChange={(e) => { patch({ connectionId: e.target.value }); setPicking(false); }}>
            <option value="">{t("engineAdmin.views.source.chooseConnection")}</option>
            {connections.map((c) => <option key={c.id} value={c.id}>{`${c.name} (${kindLabel(c.kind)})`}</option>)}
          </NativeSelect>
        )}
      </Field>
      {connections.length === 0 && <Notice tone="warning">{t("engineAdmin.views.source.noConnections")}</Notice>}

      {form.connectionId && (
        <div className="rounded-md border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">{t("engineAdmin.views.source.fromTable")}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => { setPicking((p) => !p); loadIntro(form.connectionId); }} aria-expanded={picking}>
              <Table2 className="h-3.5 w-3.5" aria-hidden="true" /> {picking ? t("engineAdmin.views.source.hideTables") : t("engineAdmin.views.source.chooseTable")}
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t("engineAdmin.views.source.fromTableHint")}</p>
          {picking && (
            <div className="mt-3">
              {intro === "loading" && <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t("engineAdmin.views.source.loadingTables")}</p>}
              {intro && typeof intro === "object" && "error" in intro && <Notice tone="danger">{intro.error}</Notice>}
              {loaded && <SchemaTablePicker intro={loaded} selected={null} onSelect={(s, tb) => { onPickTable(s, tb); setPicking(false); }} idPrefix="view-pick" />}
            </div>
          )}
        </div>
      )}

      <Field id="view-sql" label={t("engineAdmin.views.source.sql")} hint={t("engineAdmin.views.source.sqlHint")} error={errors.sql ? t(errors.sql) : undefined} required>
        {(a) => (
          <Textarea
            {...a}
            value={form.sql}
            onChange={(e) => patch({ sql: e.target.value, sampleParams: syncParams(e.target.value, form.sampleParams) })}
            rows={8}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="font-mono text-xs"
          />
        )}
      </Field>

      {form.sampleParams.length > 0 && (
        <fieldset className="space-y-2 rounded-md border border-border p-3">
          <legend className="px-1 text-sm font-medium">{t("engineAdmin.views.source.params")}</legend>
          <p className="text-xs text-muted-foreground">{t("engineAdmin.views.source.paramsHint")}</p>
          {form.sampleParams.map((p, i) => (
            <div key={p.name} className="flex items-center gap-2">
              <label htmlFor={`view-param-${i}`} className="w-32 shrink-0 truncate font-mono text-xs">:{p.name}</label>
              <Input
                id={`view-param-${i}`}
                value={p.value}
                onChange={(e) => patch({ sampleParams: form.sampleParams.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
                autoComplete="off"
              />
            </div>
          ))}
        </fieldset>
      )}

      <Notice tone="info">
        <p>{t("engineAdmin.views.source.saveNote")}</p>
      </Notice>
    </div>
  );
}

// ---- 2. Columns ------------------------------------------------------------------------------------------------------

const PII_ORDER: PiiMode[] = ["NONE", "MASK", "HIDE"];

function PiiChoice({ name, value, suggested, onChange }: { name: string; value: PiiMode; suggested: PiiMode | null; onChange: (m: PiiMode) => void }) {
  const { t } = useT();
  return (
    <div role="radiogroup" aria-label={fill(t("engineAdmin.views.columns.modeFor"), { name })} className="inline-flex overflow-hidden rounded-md border border-input">
      {PII_ORDER.map((m) => {
        const id = `pii-${name}-${m}`;
        const on = value === m;
        return (
          <label
            key={m}
            htmlFor={id}
            className={cn(
              "relative cursor-pointer px-2.5 py-1.5 text-xs font-medium transition-colors focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring",
              on ? (m === "NONE" ? "bg-muted text-foreground" : m === "MASK" ? "bg-warning/15 text-warning" : "bg-destructive/10 text-destructive") : "bg-card text-muted-foreground hover:bg-accent",
              "border-l border-input first:border-l-0",
            )}
          >
            <input id={id} type="radio" name={`pii-${name}`} checked={on} onChange={() => onChange(m)} className="sr-only" />
            {t(`engineAdmin.views.pii.${m.toLowerCase()}`)}
            {suggested === m && <span className="ml-1 text-primary" aria-label={t("engineAdmin.views.columns.suggested")} title={t("engineAdmin.views.columns.suggested")}>•</span>}
          </label>
        );
      })}
    </div>
  );
}

export function ColumnsStep({ form, patch, errors, engineMessages }: StepProps) {
  const { t } = useT();
  const setColumn = (name: string, change: Partial<ViewForm["columns"][number]>) =>
    patch({ columns: form.columns.map((c) => (c.name === name ? { ...c, ...change } : c)) });
  const differs = form.columns.some((c) => c.suggested && c.suggested !== c.pii);

  return (
    <div className="space-y-4">
      <EngineMessages messages={engineMessages} />
      {errors.columns && <Notice tone="warning">{t(errors.columns)}</Notice>}
      <p className="text-sm text-muted-foreground">{t("engineAdmin.views.columns.intro")}</p>
      <dl className="grid gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs sm:grid-cols-3">
        {PII_ORDER.map((m) => (
          <div key={m}>
            <dt className="font-medium text-foreground">{t(`engineAdmin.views.pii.${m.toLowerCase()}`)}</dt>
            <dd className="mt-0.5 text-muted-foreground">{t(`engineAdmin.views.pii.${m.toLowerCase()}Help`)}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground"><span className="text-primary">•</span> {t("engineAdmin.views.columns.legend")}</p>
        {differs && <Button type="button" size="sm" variant="ghost" onClick={() => patch({ columns: resetToSuggestions(form).columns })}>{t("engineAdmin.views.columns.reset")}</Button>}
      </div>
      <ul className="divide-y divide-border rounded-md border border-border">
        {form.columns.map((c) => (
          <li key={c.name} className="grid gap-3 p-3 md:grid-cols-[minmax(0,12rem)_1fr_auto] md:items-center">
            <div className="min-w-0">
              <p className="truncate font-mono text-sm font-medium">{c.name}</p>
              <p className="text-xs text-faint">{c.type}</p>
              {isPersonalLooking(c) && <Chip tone="warning" className="mt-1">{t("engineAdmin.views.columns.looksPersonal")}</Chip>}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <label htmlFor={`col-label-${c.name}`} className="sr-only">{fill(t("engineAdmin.views.columns.labelFor"), { name: c.name })}</label>
                <Input id={`col-label-${c.name}`} value={c.label} placeholder={t("engineAdmin.views.columns.label")} onChange={(e) => setColumn(c.name, { label: e.target.value })} autoComplete="off" />
              </div>
              <div>
                <label htmlFor={`col-desc-${c.name}`} className="sr-only">{fill(t("engineAdmin.views.columns.descriptionFor"), { name: c.name })}</label>
                <Input id={`col-desc-${c.name}`} value={c.description} placeholder={t("engineAdmin.views.columns.description")} onChange={(e) => setColumn(c.name, { description: e.target.value })} autoComplete="off" />
              </div>
            </div>
            <PiiChoice name={c.name} value={c.pii} suggested={c.suggested} onChange={(pii) => setColumn(c.name, { pii })} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- 3. Who can see it -----------------------------------------------------------------------------------------------

export function AccessStep({ form, patch, errors, engineMessages, roles }: StepProps & { roles: RoleSuggestion[] }) {
  const { t } = useT();
  return (
    <div className="space-y-5">
      <EngineMessages messages={engineMessages} />
      <RoleChips id="view-allowed" label={t("engineAdmin.views.access.allowed")} hint={t("engineAdmin.views.access.allowedHint")} values={form.allowedRoles} onChange={(v) => patch({ allowedRoles: v })} suggestions={roles} />
      <RoleChips id="view-pii" label={t("engineAdmin.views.access.pii")} hint={t("engineAdmin.views.access.piiHint")} values={form.piiRoles} onChange={(v) => patch({ piiRoles: v })} suggestions={roles} />
      <RoleChips id="view-bypass" label={t("engineAdmin.views.access.bypass")} hint={t("engineAdmin.views.access.bypassHint")} values={form.bypassRoles} onChange={(v) => patch({ bypassRoles: v })} suggestions={roles} />
      <Field id="view-refresh" label={t("engineAdmin.views.access.refresh")} hint={t("engineAdmin.views.access.refreshHint")} error={errors.refreshSeconds ? t(errors.refreshSeconds) : undefined}>
        {(a) => <Input {...a} value={form.refreshSeconds} inputMode="numeric" onChange={(e) => patch({ refreshSeconds: e.target.value })} className="max-w-40 font-mono" placeholder="300" />}
      </Field>
      <Notice tone="info"><p>{t("engineAdmin.views.access.managers")}</p></Notice>
    </div>
  );
}

// ---- 4. Row rules ----------------------------------------------------------------------------------------------------

export function RowsStep({ form, patch, errors, engineMessages, attributeNames }: StepProps & { attributeNames: string[] }) {
  const { t } = useT();
  const setRule = (i: number, change: Partial<ViewForm["rlsRules"][number]>) =>
    patch({ rlsRules: form.rlsRules.map((r, j) => (j === i ? { ...r, ...change } : r)) });
  const listId = "view-attribute-names";

  return (
    <div className="space-y-4">
      <EngineMessages messages={engineMessages} />
      <p className="text-sm text-muted-foreground">{t("engineAdmin.views.rows.intro")}</p>
      <Notice tone="info">
        <p>{t("engineAdmin.views.rows.noValue")}</p>
        <p>
          <a href="?tab=people" target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline hover:text-primary-ink">{t("engineAdmin.views.rows.peopleLink")}</a>
        </p>
      </Notice>
      <datalist id={listId}>{attributeNames.map((n) => <option key={n} value={n} />)}</datalist>

      {form.rlsRules.length === 0 && <p className="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">{t("engineAdmin.views.rows.none")}</p>}

      <ul className="space-y-3">
        {form.rlsRules.map((r, i) => (
          <li key={i} className="space-y-2 rounded-md border border-border p-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-start">
              <Field id={`rule-${i}-column`} label={t("engineAdmin.views.rows.column")} error={errors[`rule.${i}.column`] ? t(errors[`rule.${i}.column`]) : undefined}>
                {(a) => (
                  <NativeSelect {...a} value={r.column} onChange={(e) => setRule(i, { column: e.target.value })}>
                    <option value="">{t("engineAdmin.views.rows.chooseColumn")}</option>
                    {form.columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                  </NativeSelect>
                )}
              </Field>
              <Field id={`rule-${i}-op`} label={t("engineAdmin.views.rows.matches")}>
                {(a) => (
                  <NativeSelect {...a} value={r.operator} onChange={(e) => setRule(i, { operator: e.target.value as RlsOperator })}>
                    <option value="EQ">{t("engineAdmin.views.rows.opEq")}</option>
                    <option value="IN">{t("engineAdmin.views.rows.opIn")}</option>
                  </NativeSelect>
                )}
              </Field>
              <Field id={`rule-${i}-attribute`} label={t("engineAdmin.views.rows.attribute")} error={errors[`rule.${i}.attribute`] ? t(errors[`rule.${i}.attribute`]) : undefined}>
                {(a) => <Input {...a} list={listId} value={r.attribute} onChange={(e) => setRule(i, { attribute: e.target.value })} autoComplete="off" spellCheck={false} className="font-mono" placeholder="agency" />}
              </Field>
              <Button type="button" variant="ghost" size="icon" className="sm:mt-6" onClick={() => patch({ rlsRules: form.rlsRules.filter((_, j) => j !== i) })} aria-label={fill(t("engineAdmin.views.rows.remove"), { n: i + 1 })}>
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
            {r.column && r.attribute && (
              <p className="text-xs text-muted-foreground">
                {fill(t(r.operator === "EQ" ? "engineAdmin.views.rows.sentenceEq" : "engineAdmin.views.rows.sentenceIn"), { column: r.column, attribute: r.attribute })}
              </p>
            )}
          </li>
        ))}
      </ul>
      <Button type="button" variant="outline" onClick={() => patch({ rlsRules: [...form.rlsRules, { column: "", operator: "EQ", attribute: "" }] })} disabled={form.columns.length === 0}>
        <Plus className="h-4 w-4" aria-hidden="true" /> {t("engineAdmin.views.rows.add")}
      </Button>
    </div>
  );
}

// ---- 5. Public -------------------------------------------------------------------------------------------------------

export function PublicStep({ form, patch, errors, refusals, goToStep }: StepProps & { refusals: string[]; goToStep: (s: ViewStep) => void }) {
  const { t } = useT();
  const blockers = publicBlockers(form);
  const visible = form.columns.filter((c) => c.pii === "NONE").map((c) => c.name);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("engineAdmin.views.public.intro")}</p>

      <div className={cn("rounded-md border p-4", form.isPublic ? "border-warning/50 bg-warning/10" : "border-border")}>
        <label className="flex cursor-pointer items-start gap-3">
          <input
            id="view-public"
            type="checkbox"
            checked={form.isPublic}
            // Turning it off also withdraws the acknowledgement, so turning it on again asks again.
            onChange={(e) => patch({ isPublic: e.target.checked, publicAck: false })}
            className="mt-1 h-4 w-4 accent-primary"
            aria-describedby="view-public-warning"
          />
          <span>
            <span className="flex items-center gap-2 text-sm font-semibold"><Globe className="h-4 w-4" aria-hidden="true" />{t("engineAdmin.views.public.label")}</span>
            <span id="view-public-warning" className="mt-1 block text-xs leading-relaxed text-muted-foreground">{t("engineAdmin.views.public.warning")}</span>
          </span>
        </label>
      </div>

      {refusals.length > 0 && (
        <Notice tone="danger" title={t("engineAdmin.views.public.refused")}>
          <ul className="list-disc space-y-0.5 pl-4">{refusals.map((m, i) => <li key={i}>{m}</li>)}</ul>
          <p>{t("engineAdmin.views.public.refusedHelp")}</p>
        </Notice>
      )}

      {form.isPublic && (
        <>
          {blockers.length > 0 && (
            <Notice tone="warning" title={t("engineAdmin.views.public.blockedTitle")}>
              <ul className="list-disc space-y-1 pl-4">
                {blockers.map((b) => (
                  <li key={b.code}>
                    {b.code === "rowRules" && <>{t("engineAdmin.views.public.blockRowRules")} <button type="button" className="font-medium text-primary underline" onClick={() => goToStep("rows")}>{t("engineAdmin.views.public.goRows")}</button></>}
                    {b.code === "personalColumns" && <>{fill(t("engineAdmin.views.public.blockPersonal"), { columns: (b.columns ?? []).join(", ") })} <button type="button" className="font-medium text-primary underline" onClick={() => goToStep("columns")}>{t("engineAdmin.views.public.goColumns")}</button></>}
                    {b.code === "piiRoles" && t("engineAdmin.views.public.blockPii")}
                    {b.code === "bypassRoles" && t("engineAdmin.views.public.blockBypass")}
                  </li>
                ))}
              </ul>
            </Notice>
          )}
          <div className="rounded-md border border-border p-3 text-sm">
            <p className="font-medium">{t("engineAdmin.views.public.visibleTitle")}</p>
            <p className="mt-1 break-words font-mono text-xs text-muted-foreground">{visible.length ? visible.join(", ") : t("engineAdmin.views.public.visibleNone")}</p>
            <p className="mt-2 text-xs text-muted-foreground">{t("engineAdmin.views.public.visibleNote")}</p>
          </div>
          <div>
            <label className="flex cursor-pointer items-start gap-3">
              <input
                id="view-public-ack"
                type="checkbox"
                checked={form.publicAck}
                onChange={(e) => patch({ publicAck: e.target.checked })}
                className="mt-1 h-4 w-4 accent-primary"
                aria-invalid={errors.publicAck ? true : undefined}
                aria-describedby={errors.publicAck ? "view-public-ack-error" : undefined}
              />
              <span className="text-sm">{t("engineAdmin.views.public.ack")}</span>
            </label>
            {errors.publicAck && <p id="view-public-ack-error" role="alert" className="mt-1 text-xs text-destructive">{t(errors.publicAck)}</p>}
          </div>
        </>
      )}
    </div>
  );
}

// ---- Review ----------------------------------------------------------------------------------------------------------

export function ReviewStep({ form, connection, dirty, preview, previewing, previewError, onPreview, goToStep, general }: {
  form: ViewForm;
  connection: EngineConnection | undefined;
  dirty: boolean;
  preview: QueryResult | null;
  previewing: boolean;
  previewError: string | null;
  onPreview: () => void;
  goToStep: (s: ViewStep) => void;
  general: string | null;
}) {
  const { t } = useT();
  const masked = form.columns.filter((c) => c.pii === "MASK").length;
  const hidden = form.columns.filter((c) => c.pii === "HIDE").length;
  const row = (label: string, value: React.ReactNode, step: ViewStep) => (
    <div className="flex items-start justify-between gap-3 py-2">
      <dt className="w-40 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-sm">{value}</dd>
      <button type="button" onClick={() => goToStep(step)} className="shrink-0 text-xs text-primary underline hover:text-primary-ink">{t("engineAdmin.views.review.change")}</button>
    </div>
  );
  const list = (v: string[]) => (v.length ? v.join(", ") : <span className="text-faint">{t("engineAdmin.views.review.nobody")}</span>);

  return (
    <div className="space-y-4">
      {general && <Notice tone="danger">{general}</Notice>}
      <dl className="divide-y divide-border rounded-md border border-border px-3">
        {row(t("engineAdmin.views.review.name"), form.name, "source")}
        {row(t("engineAdmin.views.review.source"), connection ? `${connection.name} (${kindLabel(connection.kind)})` : "—", "source")}
        {row(t("engineAdmin.views.review.columns"), fill(t("engineAdmin.views.review.columnsValue"), { n: form.columns.length, masked, hidden }), "columns")}
        {row(t("engineAdmin.views.review.allowed"), list(form.allowedRoles), "access")}
        {row(t("engineAdmin.views.review.pii"), list(form.piiRoles), "access")}
        {row(t("engineAdmin.views.review.bypass"), list(form.bypassRoles), "access")}
        {row(t("engineAdmin.views.review.rules"), form.rlsRules.length ? form.rlsRules.map((r) => `${r.column} ← ${r.attribute}`).join(", ") : <span className="text-faint">{t("engineAdmin.views.review.noRules")}</span>, "rows")}
        {row(t("engineAdmin.views.review.public"), form.isPublic ? <Chip tone="warning"><Globe className="h-3 w-3" aria-hidden="true" />{t("engineAdmin.views.review.publicYes")}</Chip> : t("engineAdmin.views.review.publicNo"), "public")}
      </dl>

      <div className="space-y-3 rounded-md border border-border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-sm font-medium"><Eye className="h-4 w-4" aria-hidden="true" />{t("engineAdmin.views.review.previewTitle")}</p>
          <Button type="button" size="sm" variant="outline" onClick={onPreview} disabled={previewing}>
            {previewing && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {dirty ? t("engineAdmin.views.review.saveAndPreview") : t("engineAdmin.views.review.preview")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("engineAdmin.views.review.previewNote")}</p>
        {previewError && <Notice tone="danger">{previewError}</Notice>}
        {preview && (
          <div className="space-y-2" aria-live="polite">
            <p className="text-xs text-muted-foreground">
              {fill(t("engineAdmin.views.review.previewRows"), { n: preview.rowCount, shown: Math.min(preview.rows.length, 50), ms: preview.durationMs })}
              {preview.truncated && ` ${t("engineAdmin.views.review.previewTruncated")}`}
            </p>
            <ResultTable columns={preview.columns} rows={preview.rows} format={formatCell} />
          </div>
        )}
      </div>
      <p className="flex items-start gap-2 text-xs text-muted-foreground"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t("engineAdmin.views.review.publishNote")}</p>
    </div>
  );
}
