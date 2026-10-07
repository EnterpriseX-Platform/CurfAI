"use client";

import { useId, useMemo, useRef, useState } from "react";
import { AlertTriangle, FileUp, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n/LocaleContext";
import { fill } from "@/lib/i18n/fill";
import { IMPORT_MAX_ROWS, importIsSendable, importPayload, parseAttributeImport } from "@/lib/engine/attributeCsv";
import type { SyncResult } from "@/lib/engine/attributeView";
import { engineApi } from "./peopleApi";
import { SyncNotice } from "./SyncNotice";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SHOWN_PROBLEMS = 20;

type Outcome =
  | { kind: "ok"; people: number; sets: number; sync: SyncResult[] }
  | { kind: "unknown"; error: string; unknown: string[]; count: number }
  | { kind: "error"; error: string };

/** Set many people's attributes from a spreadsheet: paste or choose a file, check the preview, confirm, then see the result. */
export function AttributeImport({ onImported }: { onImported: () => void }) {
  const { t } = useT();
  const ids = { text: useId(), help: useId(), confirm: useId() };
  const [text, setText] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const parsed = useMemo(() => parseAttributeImport(text), [text]);
  const hasText = text.trim().length > 0;
  const sendable = importIsSendable(parsed);

  const change = (next: string) => {
    setText(next);
    setConfirmed(false);
    setOutcome(null);
    setFileError(null);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) { setFileError(fill(t("engineAdmin.people.import.fileTooBig"), { mb: MAX_FILE_BYTES / 1024 / 1024 })); return; }
    try {
      change(await file.text());
    } catch {
      setFileError(t("engineAdmin.people.import.fileError"));
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const send = async () => {
    setSending(true);
    setOutcome(null);
    const res = await engineApi<{ people: number; sets: number; sync: SyncResult[] }>("POST", "/api/engine/attributes/import", { rows: importPayload(parsed) });
    setSending(false);
    if (res.ok) {
      setOutcome({ kind: "ok", people: res.data.people, sets: res.data.sets, sync: res.data.sync ?? [] });
      setText("");
      setConfirmed(false);
      onImported();
      return;
    }
    const unknown = Array.isArray(res.data.unknown) ? (res.data.unknown as string[]) : null;
    if (unknown) {
      setOutcome({ kind: "unknown", error: res.error, unknown, count: typeof res.data.unknownCount === "number" ? res.data.unknownCount : unknown.length });
    } else {
      const row = typeof res.data.row === "number" ? res.data.row : null;
      setOutcome({ kind: "error", error: row ? fill(t("engineAdmin.people.import.errorRow"), { row, error: res.error }) : res.error });
    }
  };

  const problemText = (p: (typeof parsed.problems)[number]) =>
    fill(t(`engineAdmin.people.import.problem.${p.code}`), { line: p.line, ...(p.params ?? {}) });

  return (
    <section aria-labelledby="people-import-heading" className="rounded-xl border border-border bg-card p-5">
      <h2 id="people-import-heading" className="flex items-center gap-2 text-base font-semibold text-foreground">
        <FileUp className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        {t("engineAdmin.people.import.title")}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("engineAdmin.people.import.intro")}</p>
      <pre className="mt-3 overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs text-foreground" aria-label={t("engineAdmin.people.import.exampleLabel")}>
{`email,attribute,value
somchai@example.com,agency_code,A001
somchai@example.com,agency_code,A002
mali@example.com,agency_code,B014`}
      </pre>

      <div className="mt-4">
        <Label htmlFor={ids.text}>{t("engineAdmin.people.import.paste")}</Label>
        <Textarea
          id={ids.text}
          value={text}
          onChange={(e) => change(e.target.value)}
          rows={6}
          spellCheck={false}
          className="mt-1 font-mono text-xs"
          aria-describedby={ids.help}
          placeholder="email,attribute,value"
        />
        <p id={ids.help} className="mt-1 text-xs text-muted-foreground">{fill(t("engineAdmin.people.import.help"), { max: IMPORT_MAX_ROWS })}</p>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" className="sr-only" id={`${ids.text}-file`} onChange={(e) => void onFile(e.target.files?.[0])} />
        <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}>
          <Upload className="h-4 w-4" aria-hidden="true" />
          {t("engineAdmin.people.import.chooseFile")}
        </Button>
        {hasText && <Button type="button" variant="ghost" onClick={() => change("")}>{t("engineAdmin.people.import.clear")}</Button>}
        {fileError && <span role="alert" className="text-sm text-destructive">{fileError}</span>}
      </div>

      {hasText && (
        <div className="mt-4 space-y-3 rounded-md border border-border p-4" aria-label={t("engineAdmin.people.import.previewTitle")} role="group">
          <h3 className="text-sm font-semibold text-foreground">{t("engineAdmin.people.import.previewTitle")}</h3>
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">{t("engineAdmin.people.import.rows")}</dt>
              <dd className="font-mono text-foreground">{parsed.totalRows.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("engineAdmin.people.import.people")}</dt>
              <dd className="font-mono text-foreground">{parsed.people.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("engineAdmin.people.import.attributes")}</dt>
              <dd className="flex flex-wrap gap-1">
                {parsed.attributes.length ? parsed.attributes.map((a) => <span key={a} className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{a}</span>) : <span className="text-muted-foreground">—</span>}
              </dd>
            </div>
          </dl>
          {parsed.headerSkipped && <p className="text-xs text-muted-foreground">{t("engineAdmin.people.import.headerSkipped")}</p>}

          {parsed.tooMany && (
            <p role="alert" className="flex items-start gap-2 text-sm text-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
              {fill(t("engineAdmin.people.import.tooMany"), { rows: parsed.totalRows.toLocaleString(), max: IMPORT_MAX_ROWS.toLocaleString() })}
            </p>
          )}

          {parsed.problems.length > 0 && (
            <div role="alert">
              <p className="flex items-start gap-2 text-sm font-medium text-foreground">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                {fill(t("engineAdmin.people.import.problems"), { count: parsed.problems.length })}
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-9 text-sm text-muted-foreground">
                {parsed.problems.slice(0, SHOWN_PROBLEMS).map((p, i) => <li key={`${p.line}-${p.code}-${i}`}>{problemText(p)}</li>)}
              </ul>
              {parsed.problems.length > SHOWN_PROBLEMS && (
                <p className="mt-1 pl-9 text-sm text-muted-foreground">{fill(t("engineAdmin.people.import.problemsMore"), { count: parsed.problems.length - SHOWN_PROBLEMS })}</p>
              )}
            </div>
          )}

          {sendable && (
            <div className="space-y-3">
              <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                <span>{fill(t("engineAdmin.people.import.replaces"), { attributes: parsed.attributes.join(", "), people: parsed.people })}</span>
              </p>
              <div className="flex items-start gap-2">
                <input
                  id={ids.confirm}
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded-sm border-input accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <Label htmlFor={ids.confirm} className="font-normal leading-snug">{t("engineAdmin.people.import.confirm")}</Label>
              </div>
              <Button type="button" onClick={() => void send()} disabled={!confirmed || sending}>
                {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Upload className="h-4 w-4" aria-hidden="true" />}
                {sending ? t("engineAdmin.people.import.sending") : fill(t("engineAdmin.people.import.send"), { count: parsed.totalRows.toLocaleString() })}
              </Button>
            </div>
          )}
        </div>
      )}

      <div role="status" aria-live="polite" className="mt-3">
        {outcome?.kind === "ok" && (
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">{fill(t("engineAdmin.people.import.done"), { people: outcome.people, sets: outcome.sets })}</p>
            <SyncNotice sync={outcome.sync} savedKey="engineAdmin.people.import.doneSynced" />
          </div>
        )}
        {outcome?.kind === "unknown" && (
          <div role="alert" className="space-y-1 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-foreground">
            <p className="font-medium">{t("engineAdmin.people.import.unknownTitle")}</p>
            <ul className="list-disc pl-5 font-mono text-xs">
              {outcome.unknown.map((e) => <li key={e} className="break-all">{e}</li>)}
            </ul>
            {outcome.count > outcome.unknown.length && <p>{fill(t("engineAdmin.people.import.unknownMore"), { count: outcome.count - outcome.unknown.length })}</p>}
            <p className="text-muted-foreground">{t("engineAdmin.people.import.unknownAction")}</p>
          </div>
        )}
        {outcome?.kind === "error" && (
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-foreground">
            {fill(t("engineAdmin.people.import.failed"), { error: outcome.error })}
          </p>
        )}
      </div>
    </section>
  );
}
