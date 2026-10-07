"use client";

import { useMemo, useRef, useState } from "react";
import { Database, Loader2 } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogIcon, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ConnectionKind, EngineConnection, TlsMode } from "@/lib/engine/adminClient";
import {
  CONNECTION_KINDS, TLS_MODES, changeKind, connectionField, fromConnection, toConnectionRequest, validateConnection,
  type ConnectionForm,
} from "@/lib/engine/connectionForm";
import { Field, NativeSelect, Notice, problemText, useAdminCall } from "./adminUi";

type Props = {
  dataSourceId: string;
  /** The form to start from: blank for a new connection, filled from the engine's own record to edit. */
  initial: ConnectionForm;
  onClose: () => void;
  onSaved: (saved: EngineConnection) => void;
};

/** What the "database" field is called for each kind. */
function databaseLabelKey(kind: ConnectionKind): string {
  if (kind === "ORACLE") return "engineAdmin.databases.field.databaseOracle";
  if (kind === "TRINO") return "engineAdmin.databases.field.databaseTrino";
  return "engineAdmin.databases.field.database";
}

export function ConnectionDialog({ dataSourceId, initial, onClose, onSaved }: Props) {
  const { t } = useT();
  const call = useAdminCall(dataSourceId);
  const editing = Boolean(initial.id);
  const [form, setForm] = useState<ConnectionForm>(initial);
  const [baseline, setBaseline] = useState(() => JSON.stringify(initial));
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [saving, setSaving] = useState(false);
  const firstError = useRef<string | null>(null);

  const dirty = useMemo(() => JSON.stringify(form) !== baseline, [form, baseline]);
  const set = <K extends keyof ConnectionForm>(key: K, value: ConnectionForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => (key in e ? { ...e, [key]: [] } : e));
  };

  const requestClose = () => {
    if (dirty && !window.confirm(t("engineAdmin.databases.dialog.discard"))) return;
    onClose();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const local = validateConnection(form);
    if (Object.keys(local).length) {
      setErrors(Object.fromEntries(Object.entries(local).map(([k, v]) => [k, [t(v as string)]])));
      setGeneral(null);
      firstError.current = Object.keys(local)[0];
      document.getElementById(`conn-${firstError.current}`)?.focus();
      return;
    }
    setSaving(true);
    setErrors({});
    setGeneral(null);
    const res = await call<EngineConnection>(editing ? "PUT" : "POST", editing ? `/connections/${form.id}` : "/connections", { body: toConnectionRequest(form) });
    setSaving(false);
    if (res.ok) { onSaved(res.data); return; }
    const p = res.problem;
    if (p.stale) { setStale(true); return; }
    const byField: Record<string, string[]> = {};
    const rest: string[] = [];
    for (const [name, messages] of Object.entries(p.fields)) {
      const field = connectionField(name);
      if (field) byField[field] = [...(byField[field] ?? []), ...messages];
      else rest.push(...messages);
    }
    setErrors(byField);
    if (rest.length) setGeneral(rest.join(" "));
    else if (Object.keys(byField).length === 0) setGeneral(problemText(p, t("engineAdmin.databases.err.saveFailed"), t("engineAdmin.databases.err.unreachable")));
  };

  const reload = async () => {
    if (!form.id) return;
    const res = await call<EngineConnection>("GET", `/connections/${form.id}`);
    if (!res.ok) { setGeneral(problemText(res.problem, t("engineAdmin.databases.err.loadFailed"), t("engineAdmin.databases.err.unreachable"))); return; }
    // The typed password is kept: it is what the admin meant to change.
    const fresh = { ...fromConnection(res.data), password: form.password };
    setForm(fresh);
    setBaseline(JSON.stringify({ ...fresh, password: "" }));
    setStale(false);
  };

  const tlsNote = form.tlsMode === "VERIFY" ? null : form.tlsMode === "REQUIRE" ? "engineAdmin.databases.tls.requireWarning" : "engineAdmin.databases.tls.disableWarning";

  return (
    <Dialog open onOpenChange={(open) => { if (!open) requestClose(); }}>
      <DialogContent className="max-w-xl" aria-describedby="conn-desc">
        <form onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogIcon><Database className="h-4 w-4" aria-hidden="true" /></DialogIcon>
            <div>
              <DialogTitle>{editing ? t("engineAdmin.databases.dialog.editTitle") : t("engineAdmin.databases.dialog.newTitle")}</DialogTitle>
              <DialogDescription id="conn-desc">{t("engineAdmin.databases.dialog.intro")}</DialogDescription>
            </div>
          </DialogHeader>
          <DialogBody>
            <Notice tone="info" title={t("engineAdmin.databases.dialog.selectOnlyTitle")}>
              <p>{t("engineAdmin.databases.dialog.selectOnly")}</p>
            </Notice>

            {stale && (
              <Notice tone="warning" title={t("engineAdmin.databases.stale.title")}>
                <p>{t("engineAdmin.databases.stale.body")}</p>
                <Button type="button" size="sm" variant="outline" onClick={reload}>{t("engineAdmin.databases.stale.reload")}</Button>
              </Notice>
            )}
            {general && <Notice tone="danger">{general}</Notice>}

            <Field id="conn-name" label={t("engineAdmin.databases.field.name")} hint={t("engineAdmin.databases.field.nameHint")} error={errors.name} required>
              {(a) => <Input {...a} value={form.name} maxLength={100} onChange={(e) => set("name", e.target.value)} autoComplete="off" />}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="conn-kind" label={t("engineAdmin.databases.field.kind")} required>
                {(a) => (
                  <NativeSelect {...a} value={form.kind} onChange={(e) => setForm((f) => changeKind(f, e.target.value as ConnectionKind))}>
                    {CONNECTION_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                  </NativeSelect>
                )}
              </Field>
              <Field id="conn-port" label={t("engineAdmin.databases.field.port")} error={errors.port}>
                {(a) => <Input {...a} value={form.port} inputMode="numeric" onChange={(e) => set("port", e.target.value)} className="font-mono" />}
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="conn-host" label={t("engineAdmin.databases.field.host")} hint={t("engineAdmin.databases.field.hostHint")} error={errors.host} required>
                {(a) => <Input {...a} value={form.host} onChange={(e) => set("host", e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" />}
              </Field>
              <Field id="conn-database" label={t(databaseLabelKey(form.kind))} error={errors.database} required>
                {(a) => <Input {...a} value={form.database} onChange={(e) => set("database", e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" />}
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="conn-username" label={t("engineAdmin.databases.field.username")} error={errors.username} required>
                {(a) => <Input {...a} value={form.username} onChange={(e) => set("username", e.target.value)} autoComplete="off" spellCheck={false} />}
              </Field>
              <Field
                id="conn-password"
                label={t("engineAdmin.databases.field.password")}
                hint={editing && form.hasPassword ? t("engineAdmin.databases.field.passwordKeep") : t("engineAdmin.databases.field.passwordNew")}
                error={errors.password}
                required={!editing}
              >
                {(a) => (
                  <Input {...a} type="password" value={form.password} onChange={(e) => set("password", e.target.value)} autoComplete="new-password"
                    placeholder={editing && form.hasPassword ? "••••••••" : undefined} />
                )}
              </Field>
            </div>

            <Field id="conn-tls" label={t("engineAdmin.databases.field.tls")} hint={t(`engineAdmin.databases.tls.${form.tlsMode.toLowerCase()}`)} error={errors.tlsMode}>
              {(a) => (
                <NativeSelect {...a} value={form.tlsMode} onChange={(e) => set("tlsMode", e.target.value as TlsMode)}>
                  {TLS_MODES.map((m) => <option key={m} value={m}>{t(`engineAdmin.databases.tls.${m.toLowerCase()}Label`)}</option>)}
                </NativeSelect>
              )}
            </Field>
            {tlsNote && <Notice tone="warning">{t(tlsNote)}</Notice>}

            <div className="rounded-md border border-border p-3">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  id="conn-allowRawSql"
                  type="checkbox"
                  checked={form.allowRawSql}
                  onChange={(e) => set("allowRawSql", e.target.checked)}
                  className="mt-1 h-4 w-4 accent-primary"
                  aria-describedby="conn-raw-hint"
                />
                <span>
                  <span className="block text-sm font-medium text-foreground">{t("engineAdmin.databases.field.rawSql")}</span>
                  <span id="conn-raw-hint" className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{t("engineAdmin.databases.field.rawSqlHint")}</span>
                </span>
              </label>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={requestClose}>{t("engineAdmin.databases.dialog.cancel")}</Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {saving ? t("engineAdmin.databases.dialog.saving") : editing ? t("engineAdmin.databases.dialog.saveChanges") : t("engineAdmin.databases.dialog.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
