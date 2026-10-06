"use client";
/**
 * Add a column to a lake table — a formula column or a blank one — or change
 * a formula column's formula. Opened from the table page, its Manage panel
 * and the spreadsheet view; one dialog for all three.
 *
 * A formula is checked as it's typed, in the browser, by the same compiler the
 * server saves with (lib/lake/formula/compile.ts — pure, no server imports),
 * so a missing ), a misspelt column or text used as a number shows at once,
 * in the reader's language, pointing at the spot. Once it checks out, the
 * server previews it on the table's first rows and counts how many of a
 * sample it would leave blank; saving checks it once more there.
 *
 * "Describe it" asks the workspace's model to write the formula
 * (lib/lake/formula/suggest.ts); what comes back goes through the same checks
 * as a formula typed by hand.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, Sparkles, SquareFunction, Trash2 } from "lucide-react";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogIcon, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/lib/i18n/LocaleContext";
import { compileFormula, FORMULA_FUNCTIONS, type FormulaType } from "@/lib/lake/formula/compile";
import { FormulaError, formulaRef as columnRef } from "@/lib/lake/formula/parse";
import { NEW_COLUMN_NAME_RE } from "@/lib/lake/columnName";
import { formulaErrorText, FORMULA_FUNCTION_DOCS, type FormulaErrorParams } from "@/lib/lake/formula/messages";

export type EditorColumn = { name: string; type: string; formula?: string | null };

type Problem = { key?: string; params?: FormulaErrorParams; message?: string; at?: number };
type Preview = { type: FormulaType; uses: string[]; valueKey: string; rows: Array<Record<string, unknown>>; sampled: number; blank: number };
type BlankType = "text" | "number" | "date" | "boolean";

const NAME_RE = NEW_COLUMN_NAME_RE;

export function ColumnEditor({
  tableName, columns, editing, open, onOpenChange, onSaved,
}: {
  tableName: string;
  columns: EditorColumn[];
  /** The formula column being changed; absent to add a column. */
  editing?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After a save or a removal, with the table's columns as the server now has them. */
  onSaved: (schema: EditorColumn[] | null) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        {/* Keyed so each opening starts clean. */}
        {open && <EditorBody key={editing ?? "new"} tableName={tableName} columns={columns} editing={editing ?? null} onDone={(s) => { onSaved(s); onOpenChange(false); }} onCancel={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function EditorBody({
  tableName, columns, editing, onDone, onCancel,
}: {
  tableName: string;
  columns: EditorColumn[];
  editing: string | null;
  onDone: (schema: EditorColumn[] | null) => void;
  onCancel: () => void;
}) {
  const { t, locale } = useT();
  const current = editing ? columns.find((c) => c.name === editing) : undefined;
  const [kind, setKind] = useState<"formula" | "blank">("formula");
  const [name, setName] = useState(editing ?? "");
  const [formula, setFormula] = useState(current?.formula ?? "");
  const [blankType, setBlankType] = useState<BlankType>("text");
  const [blankDefault, setBlankDefault] = useState("");
  const [describe, setDescribe] = useState("");
  const [ai, setAi] = useState<{ state: "idle" | "busy" | "ok" | "error"; text?: string }>({ state: "idle" });
  const [preview, setPreview] = useState<{ state: "idle" | "busy" | "ok" | "error"; data?: Preview; problem?: Problem }>({ state: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveProblem, setSaveProblem] = useState<Problem | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const formulaRef = useRef<HTMLTextAreaElement>(null);
  const endpoint = `/api/lake/tables/${encodeURIComponent(tableName)}`;

  // ---- The name ------------------------------------------------------------
  const nameProblem = useMemo(() => {
    const n = name.trim();
    if (editing || !n) return null;
    if (!NAME_RE.test(n)) return t("colEditor.nameInvalid");
    if (columns.some((c) => c.name.toLowerCase() === n.toLowerCase())) return t("colEditor.nameTaken").replace("{name}", n);
    return null;
  }, [name, editing, columns, t]);

  // ---- The formula, checked as it's typed ----------------------------------
  const check = useMemo((): { ok: true; type: FormulaType; uses: string[] } | { ok: false; problem: Problem } | null => {
    if (!formula.trim()) return null;
    try {
      const c = compileFormula(formula, { columns, dialect: "sqlite", self: editing ?? undefined });
      return { ok: true, type: c.type, uses: c.uses };
    } catch (e) {
      if (e instanceof FormulaError) return { ok: false, problem: { key: e.key, params: e.params, message: e.message, at: e.at } };
      return { ok: false, problem: { message: String((e as Error)?.message ?? e) } };
    }
  }, [formula, columns, editing]);

  // Once it checks out here, the server runs it on the table's rows.
  useEffect(() => {
    if (kind !== "formula" || !check?.ok) { setPreview({ state: "idle" }); return; }
    const ctrl = new AbortController();
    const id = setTimeout(async () => {
      setPreview((p) => ({ ...p, state: "busy" }));
      try {
        const res = await fetch(`${endpoint}/formula`, {
          method: "POST", headers: { "content-type": "application/json" }, signal: ctrl.signal,
          body: JSON.stringify({ action: "preview", formula, ...(editing ? { name: editing } : {}) }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) setPreview({ state: "error", problem: { key: body.key, params: body.params, message: body.error ?? t("colEditor.previewFailed"), at: body.at } });
        else setPreview({ state: "ok", data: body as Preview });
      } catch (e) {
        if ((e as Error)?.name !== "AbortError") setPreview({ state: "error", problem: { message: t("colEditor.previewFailed") } });
      }
    }, 450);
    return () => { clearTimeout(id); ctrl.abort(); };
  }, [kind, check?.ok, formula, editing, endpoint, t]);

  const problem: Problem | null = check && !check.ok ? check.problem : preview.state === "error" ? preview.problem ?? null : null;
  const problemText = (p: Problem) => formulaErrorText(locale, p);
  /** A "Describe it" that didn't work, in the reader's language where it's our own words (the model's reason is its own). */
  const suggestionError = (b: { code?: string; error?: string; key?: string; params?: FormulaErrorParams }) =>
    b.code === "invalid" && b.key && b.key !== "suggest_empty"
      ? t("colEditor.aiInvalid").replace("{problem}", formulaErrorText(locale, { key: b.key, params: b.params, message: b.error }))
      : b.key ? formulaErrorText(locale, { key: b.key, params: b.params, message: b.error }) : (b.error ?? t("colEditor.aiFailed"));

  const insert = (text: string) => {
    const el = formulaRef.current;
    const at = el?.selectionStart ?? formula.length;
    const end = el?.selectionEnd ?? at;
    const before = formula.slice(0, at);
    const pad = before && !/[\s(,]$/.test(before) ? " " : "";
    const next = before + pad + text + formula.slice(end);
    setFormula(next);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = at + pad.length + text.length;
      el?.setSelectionRange(pos, pos);
    });
  };
  const showAt = (at: number) => {
    const el = formulaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(at, Math.min(at + 1, formula.length));
  };

  // ---- Describe it ----------------------------------------------------------
  async function writeFormula(text = describe) {
    const description = text.trim();
    if (!description) return;
    setDescribe(description);
    setAi({ state: "busy" });
    try {
      const res = await fetch(`${endpoint}/formula`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "suggest", description }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setAi({ state: "error", text: body.error ?? t("colEditor.aiFailed") }); return; }
      if (!body.ok) { setAi({ state: "error", text: suggestionError(body) }); return; }
      setFormula(body.formula);
      if (!editing && (!name.trim() || nameProblem)) setName(body.name);
      setAi({ state: "ok", text: body.explanation });
    } catch {
      setAi({ state: "error", text: t("colEditor.aiFailed") });
    }
  }

  // ---- Saving -------------------------------------------------------------
  async function post(payload: Record<string, unknown>) {
    setSaving(true);
    setSaveProblem(null);
    try {
      const res = await fetch(`${endpoint}/schema`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setSaveProblem({ key: body.key, params: body.params, message: body.error ?? t("colEditor.saveFailed"), at: body.at }); return; }
      onDone(Array.isArray(body.schema) ? body.schema : null);
    } catch {
      setSaveProblem({ message: t("colEditor.saveFailed") });
    } finally {
      setSaving(false);
    }
  }
  const save = () => {
    if (kind === "blank") {
      void post({ action: "addColumn", name: name.trim(), type: blankType, ...(blankDefault.trim() ? { defaultValue: blankDefault.trim() } : {}) });
    } else {
      void post({ action: editing ? "setFormula" : "addFormula", name: editing ?? name.trim(), formula });
    }
  };
  const canSave = !saving && (editing || (name.trim() && !nameProblem)) && (kind === "blank" || check?.ok === true)
    && !(editing && formula === current?.formula);

  const fnDocs = locale === "th" || locale === "zh" ? FORMULA_FUNCTION_DOCS[locale] : null;
  const otherColumns = columns.filter((c) => c.name !== editing);
  const examples = [t("colEditor.example1"), t("colEditor.example2"), t("colEditor.example3")];

  return (
    <>
      <DialogHeader>
        <DialogIcon><SquareFunction className="h-4 w-4" /></DialogIcon>
        <div className="min-w-0 flex-1">
          <DialogTitle>{editing ? t("colEditor.editTitle").replace("{name}", editing) : t("colEditor.addTitle")}</DialogTitle>
          <DialogDescription>
            {editing ? t("colEditor.editSubtitle") : t("colEditor.addSubtitle").replace("{table}", tableName)}
          </DialogDescription>
        </div>
        {!editing && (
          <div className="flex shrink-0 gap-1 rounded-lg bg-muted p-1" role="group" aria-label={t("colEditor.kindLabel")}>
            {(["formula", "blank"] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className={`rounded-md px-3 py-1 text-[13px] font-medium ${kind === k ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
              >
                {t(k === "formula" ? "colEditor.kindFormula" : "colEditor.kindBlank")}
              </button>
            ))}
          </div>
        )}
      </DialogHeader>

      {kind === "formula" ? (
        <DialogBody>
          {/* Describe it */}
          <div className="space-y-2 rounded-lg border border-primary/40 bg-primary-soft p-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-primary-ink">
              <Sparkles className="h-3.5 w-3.5" /> {t("colEditor.describeHeading")}
            </p>
            <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void writeFormula(); }}>
              <input
                value={describe}
                onChange={(e) => setDescribe(e.target.value)}
                maxLength={500}
                placeholder={t("colEditor.describePlaceholder")}
                aria-label={t("colEditor.describeHeading")}
                className="h-9 min-w-0 flex-[1_1_260px] rounded-md border border-border bg-card px-3 text-[13px]"
              />
              <button
                type="submit"
                disabled={ai.state === "busy" || !describe.trim()}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-semibold text-primary-foreground hover:bg-primary-ink disabled:opacity-50"
              >
                {ai.state === "busy" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                {t("colEditor.describeButton")}
              </button>
            </form>
            {ai.state === "idle" && !formula && (
              <div className="flex flex-wrap gap-1.5">
                {examples.map((x) => (
                  <button key={x} type="button" onClick={() => void writeFormula(x)} className="rounded-full border border-border bg-card px-2.5 py-0.5 text-[11.5px] text-muted-foreground hover:border-primary hover:text-primary-ink">
                    {x}
                  </button>
                ))}
              </div>
            )}
            {ai.state === "ok" && <p className="flex items-start gap-1.5 text-xs text-success"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />{ai.text}</p>}
            {ai.state === "error" && <p className="flex items-start gap-1.5 text-xs text-destructive"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{ai.text}</p>}
          </div>

          <div className="flex flex-wrap gap-3">
            <label className="flex min-w-0 flex-[0_1_220px] flex-col gap-1">
              <span className="text-xs font-semibold">{t("colEditor.nameLabel")}</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!!editing}
                placeholder="gross_profit"
                spellCheck={false}
                className="h-9 rounded-md border border-border bg-background px-3 font-mono text-[13px] disabled:opacity-60"
              />
              {nameProblem && <span className="text-[11.5px] text-destructive">{nameProblem}</span>}
            </label>
            <label className="flex min-w-0 flex-[3_1_320px] flex-col gap-1">
              <span className="text-xs font-semibold">{t("colEditor.formulaLabel")}</span>
              <textarea
                ref={formulaRef}
                value={formula}
                onChange={(e) => setFormula(e.target.value)}
                spellCheck={false}
                rows={3}
                placeholder="revenue * margin_pct"
                aria-invalid={!!problem}
                className={`min-h-[4.5rem] resize-y rounded-md border bg-background px-3 py-2 font-mono text-[13px] leading-relaxed ${problem ? "border-destructive" : "border-border"}`}
              />
            </label>
          </div>

          {otherColumns.length > 0 && (
            <div className="space-y-1">
              <p className="text-[11.5px] text-muted-foreground">{t("colEditor.insertHint")}</p>
              <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
                {otherColumns.map((c) => (
                  <button
                    key={c.name}
                    type="button"
                    title={c.formula ? `= ${c.formula}` : c.type}
                    onClick={() => insert(columnRef(c.name))}
                    className={`rounded border px-1.5 py-0.5 font-mono text-[11.5px] hover:border-primary hover:text-primary-ink ${c.formula ? "border-primary/30 bg-primary-soft text-primary-ink" : "border-border bg-background"}`}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* The check */}
          <div aria-live="polite">
            {problem ? (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
                <p className="flex items-start gap-1.5"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{problemText(problem)}</p>
                {problem.at != null && formula.trim() && (
                  <button type="button" onClick={() => showAt(problem.at!)} className="mt-1.5 block w-full overflow-x-auto text-left" title={t("colEditor.showSpot")}>
                    <Pointer src={formula} at={problem.at} />
                  </button>
                )}
              </div>
            ) : check?.ok ? (
              <p className="flex items-center gap-1.5 rounded-md bg-success/10 px-3 py-2 text-[12.5px] text-success">
                <Check className="h-3.5 w-3.5 shrink-0" />
                {t("colEditor.checksOut")
                  .replace("{type}", t(`sheet.type.${check.type}`))
                  .replace("{uses}", check.uses.join(", ") || "—")}
              </p>
            ) : null}
          </div>

          {check?.ok && (preview.state === "ok" || preview.state === "busy") && (
            <PreviewTable data={preview.data} busy={preview.state === "busy"} resultLabel={name.trim() || editing || t("colEditor.result")} />
          )}

          <details className="text-[11.5px] text-muted-foreground">
            <summary className="cursor-pointer select-none">{t("colEditor.functionsHeading")}</summary>
            <div className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
              {Object.entries(FORMULA_FUNCTIONS).map(([fn, f]) => (
                <button key={fn} type="button" onClick={() => insert(`${fn}(`)} className="text-left hover:text-foreground">
                  <code className="font-mono text-foreground">{f.sig}</code> — {fnDocs?.[fn] ?? f.does}
                </button>
              ))}
              <p><code className="font-mono text-foreground">+ − * /</code> — {t("colEditor.opsArithmetic")}</p>
              <p><code className="font-mono text-foreground">&amp;</code> — {t("colEditor.opsJoin")}</p>
              <p><code className="font-mono text-foreground">= &lt;&gt; &lt; &gt; &lt;= &gt;=</code> — {t("colEditor.opsCompare")}</p>
              <p><code className="font-mono text-foreground">&quot;text&quot; · [my column]</code> — {t("colEditor.opsLiterals")}</p>
            </div>
          </details>
          <p className="text-[11.5px] text-muted-foreground">{t("colEditor.note")}</p>
        </DialogBody>
      ) : (
        <DialogBody>
          <div className="flex flex-wrap gap-3">
            <label className="flex min-w-0 flex-[1_1_200px] flex-col gap-1">
              <span className="text-xs font-semibold">{t("colEditor.nameLabel")}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="promo_code" spellCheck={false}
                className="h-9 rounded-md border border-border bg-background px-3 font-mono text-[13px]" />
              {nameProblem && <span className="text-[11.5px] text-destructive">{nameProblem}</span>}
            </label>
            <label className="flex min-w-0 flex-[1_1_200px] flex-col gap-1">
              <span className="text-xs font-semibold">{t("colEditor.fillLabel")}</span>
              <input value={blankDefault} onChange={(e) => setBlankDefault(e.target.value)} placeholder={t("colEditor.fillPlaceholder")}
                className="h-9 rounded-md border border-border bg-background px-3 text-[13px]" />
            </label>
          </div>
          <div className="space-y-1">
            <p className="text-xs font-semibold">{t("colEditor.typeLabel")}</p>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("colEditor.typeLabel")}>
              {(["text", "number", "date", "boolean"] as const).map((ty) => (
                <button
                  key={ty}
                  type="button"
                  aria-pressed={blankType === ty}
                  onClick={() => setBlankType(ty)}
                  className={`h-8 rounded-md border px-3 text-[13px] ${blankType === ty ? "border-primary bg-primary-soft font-semibold text-primary-ink" : "border-border bg-card hover:bg-muted"}`}
                >
                  {t(`sheet.type.${ty}`)}
                </button>
              ))}
            </div>
          </div>
        </DialogBody>
      )}

      {saveProblem && (
        <p className="mx-5 mb-3 flex items-start gap-1.5 rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{problemText(saveProblem)}
        </p>
      )}

      <DialogFooter className="flex-wrap justify-between">
        <div>
          {editing && (confirmRemove ? (
            <span className="flex flex-wrap items-center gap-2 text-[12.5px] text-destructive">
              {t("colEditor.removeConfirm").replace("{name}", editing)}
              <button type="button" disabled={saving} onClick={() => void post({ action: "dropColumn", name: editing })}
                className="inline-flex h-8 items-center rounded-md bg-destructive px-3 text-[13px] font-semibold text-destructive-foreground disabled:opacity-50">
                {t("colEditor.remove")}
              </button>
              <button type="button" onClick={() => setConfirmRemove(false)} className="h-8 rounded-md px-2 text-[13px] text-muted-foreground hover:bg-muted">
                {t("colEditor.keep")}
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmRemove(true)} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] text-destructive hover:bg-destructive/10">
              <Trash2 className="h-3.5 w-3.5" /> {t("colEditor.removeColumn")}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} className="h-8 rounded-md border border-border bg-card px-3 text-[13px] font-medium hover:bg-accent">
            {t("action.cancel")}
          </button>
          <button type="button" onClick={save} disabled={!canSave}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-semibold text-primary-foreground hover:bg-primary-ink disabled:opacity-50">
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t(editing ? "colEditor.saveFormula" : "colEditor.addColumn")}
          </button>
        </div>
      </DialogFooter>
    </>
  );
}

/** The line of the formula with the problem, and a mark under the spot. */
function Pointer({ src, at }: { src: string; at: number }) {
  let start = 0;
  const lines = src.split("\n");
  for (const line of lines) {
    if (at <= start + line.length) {
      return (
        <pre className="font-mono text-[12px] leading-snug text-foreground">
          {line}{"\n"}<span className="text-destructive">{" ".repeat(at - start)}^</span>
        </pre>
      );
    }
    start += line.length + 1;
  }
  return null;
}

function PreviewTable({ data, busy, resultLabel }: { data?: Preview; busy: boolean; resultLabel: string }) {
  const { t, locale } = useT();
  if (!data) {
    return <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t("colEditor.previewing")}</p>;
  }
  const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 10 });
  const show = (v: unknown, type?: string) => {
    if (v == null || v === "") return "—";
    if (typeof v === "boolean") return t(v ? "sheet.yes" : "sheet.no");
    if (type === "number" && Number.isFinite(Number(v))) return nf.format(Number(v));
    return String(v);
  };
  return (
    <div className={`space-y-1.5 ${busy ? "opacity-60" : ""}`}>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="min-w-full text-[12px]">
          <thead>
            <tr className="bg-muted">
              {data.uses.map((u) => <th key={u} className="whitespace-nowrap px-2.5 py-1.5 text-left font-mono text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">{u}</th>)}
              <th className="whitespace-nowrap bg-primary-soft px-2.5 py-1.5 text-left font-mono text-[10.5px] font-medium uppercase tracking-wide text-primary-ink">{resultLabel}</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r, i) => (
              <tr key={i} className="border-t border-border">
                {data.uses.map((u) => <td key={u} className="whitespace-nowrap px-2.5 py-1.5">{show(r[u])}</td>)}
                <td className={`whitespace-nowrap bg-primary-soft/60 px-2.5 py-1.5 font-semibold ${data.type === "number" ? "text-right tabular-nums" : ""}`}>{show(r[data.valueKey], data.type)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={`text-[11.5px] ${data.blank > 0 ? "text-warning" : "text-muted-foreground"}`}>
        {data.blank > 0
          ? t("colEditor.blankWarning").replace("{blank}", data.blank.toLocaleString(locale)).replace("{sampled}", data.sampled.toLocaleString(locale))
          : t("colEditor.checkedOn").replace("{sampled}", data.sampled.toLocaleString(locale))}
      </p>
    </div>
  );
}
