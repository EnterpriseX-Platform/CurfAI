"use client";

import { useId, useRef, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n/LocaleContext";
import { fill } from "@/lib/i18n/fill";
import { addValues, checkEdit, removeValue, splitValueInput, suggestNames, validateValue, validateValues, type FormError } from "@/lib/engine/attributeForm";
import { memberLabel, type Member, type SyncResult } from "@/lib/engine/attributeView";
import { engineApi } from "./peopleApi";

export type SavedChange = { name: string; values: string[]; sync: SyncResult[] };

/** Add or remove the values one person holds for an attribute. Saving replaces everything they hold for it. */
export function PersonEditDialog({ member, knownNames, onClose, onSaved }: {
  member: Member;
  knownNames: string[];
  onClose: () => void;
  onSaved: (change: SavedChange, member: Member) => void;
}) {
  const { t } = useT();
  const ids = { name: useId(), nameHelp: useId(), values: useId(), valuesHelp: useId(), error: useId() };
  const held = Object.keys(member.attributes).filter((n) => member.attributes[n]?.length);
  const first = held[0] ?? "";
  const [name, setName] = useState(first);
  const [values, setValues] = useState<string[]>(first ? member.attributes[first] : []);
  const [draft, setDraft] = useState("");
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<FormError | null>(null);
  const [valuesError, setValuesError] = useState<FormError | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const draftRef = useRef<HTMLInputElement>(null);

  const text = (e: FormError) => fill(t(`engineAdmin.people.error.${e.code}`), e.params);
  const trimmed = name.trim();
  const suggestions = suggestNames([...new Set([...held, ...knownNames])], name).slice(0, 8);

  const pickName = (next: string) => {
    setName(next);
    setNameError(null);
    setServerError(null);
    setValues(member.attributes[next] ?? []);
    setTouched(false);
  };

  const onNameChange = (next: string) => {
    setName(next);
    setNameError(null);
    // Typing the exact name of something this person already holds shows what they hold, unless edits are underway.
    if (!touched && member.attributes[next.trim()]) setValues(member.attributes[next.trim()]);
  };

  /** Moves what is typed into the list, refusing a value the server would refuse. Returns the new list, or null. */
  const commitDraft = (): string[] | null => {
    const typed = splitValueInput(draft);
    for (const v of typed) {
      const bad = validateValue(v);
      if (bad) { setValuesError(bad); return null; }
    }
    const next = addValues(values, draft);
    const tooMany = validateValues(next);
    if (tooMany) { setValuesError(tooMany); return null; }
    setValues(next);
    setDraft("");
    setValuesError(null);
    setTouched(true);
    return next;
  };

  const save = async () => {
    const list = draft.trim() ? commitDraft() : values;
    if (!list) return;
    const check = checkEdit({ name, values: list });
    if (!check.ok) { setNameError(check.name); setValuesError(check.values); return; }
    setSaving(true);
    setServerError(null);
    const res = await engineApi<{ saved: { name: string; values: string[] }; sync: SyncResult[] }>("PUT", "/api/engine/attributes", {
      userId: member.userId,
      name: check.name,
      values: check.values,
    });
    setSaving(false);
    if (!res.ok) { setServerError(res.error); return; }
    const saved = res.data.saved ?? { name: check.name, values: check.values };
    const attributes = { ...member.attributes };
    if (saved.values.length) attributes[saved.name] = saved.values; else delete attributes[saved.name];
    onSaved({ name: saved.name, values: saved.values, sync: res.data.sync ?? [] }, { ...member, attributes });
  };

  const who = memberLabel(member);
  const removing = values.length === 0 && !draft.trim() && Boolean(member.attributes[trimmed]?.length);

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div>
            <DialogTitle>{fill(t("engineAdmin.people.edit.title"), { who })}</DialogTitle>
            <DialogDescription className="mt-1">{t("engineAdmin.people.edit.intro")}</DialogDescription>
          </div>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <DialogBody>
            <div>
              <Label htmlFor={ids.name}>{t("engineAdmin.people.edit.attribute")}</Label>
              <Input
                id={ids.name}
                value={name}
                onChange={(e) => onNameChange(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                maxLength={64}
                className="mt-1 font-mono"
                aria-invalid={nameError ? true : undefined}
                aria-describedby={`${ids.nameHelp}${nameError ? ` ${ids.error}-name` : ""}`}
                placeholder="agency_code"
              />
              <p id={ids.nameHelp} className="mt-1 text-xs text-muted-foreground">{t("engineAdmin.people.edit.attributeHelp")}</p>
              {nameError && <p id={`${ids.error}-name`} role="alert" className="mt-1 text-xs text-destructive">{text(nameError)}</p>}
              {suggestions.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-label={t("engineAdmin.people.edit.existing")}>
                  <span className="text-xs text-muted-foreground">{t("engineAdmin.people.edit.existing")}</span>
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => pickName(s)}
                      className="rounded-md border border-border bg-card px-2 py-0.5 font-mono text-xs text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <Label htmlFor={ids.values}>{t("engineAdmin.people.edit.values")}</Label>
              <div className="mt-1 flex gap-2">
                <Input
                  id={ids.values}
                  ref={draftRef}
                  value={draft}
                  onChange={(e) => { setDraft(e.target.value); setValuesError(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitDraft(); } }}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  aria-invalid={valuesError ? true : undefined}
                  aria-describedby={`${ids.valuesHelp}${valuesError ? ` ${ids.error}-values` : ""}`}
                  placeholder="A001"
                />
                <Button type="button" variant="outline" onClick={() => { commitDraft(); draftRef.current?.focus(); }} disabled={!draft.trim()}>
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  {t("engineAdmin.people.edit.add")}
                </Button>
              </div>
              <p id={ids.valuesHelp} className="mt-1 text-xs text-muted-foreground">{t("engineAdmin.people.edit.valuesHelp")}</p>
              {valuesError && <p id={`${ids.error}-values`} role="alert" className="mt-1 text-xs text-destructive">{text(valuesError)}</p>}

              <div className="mt-3 rounded-md border border-border bg-muted/40 p-2.5">
                {values.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("engineAdmin.people.edit.noValues")}</p>
                ) : (
                  <ul className="flex flex-wrap gap-1.5" aria-label={fill(t("engineAdmin.people.edit.currentValues"), { count: values.length })}>
                    {values.map((v) => (
                      <li key={v} className="inline-flex items-center gap-1 rounded-md border border-border bg-card py-0.5 pl-2 pr-0.5 font-mono text-xs text-foreground">
                        <span className="break-all">{v}</span>
                        <button
                          type="button"
                          onClick={() => { setValues(removeValue(values, v)); setTouched(true); setValuesError(null); }}
                          aria-label={fill(t("engineAdmin.people.edit.remove"), { value: v })}
                          className="inline-flex h-5 w-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <X className="h-3 w-3" aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {removing && (
              <p className="text-sm text-warning" role="status">{fill(t("engineAdmin.people.edit.removeWarning"), { who, name: trimmed })}</p>
            )}
            {serverError && (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-sm text-foreground">
                {fill(t("engineAdmin.people.edit.saveFailed"), { error: serverError })}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>{t("engineAdmin.people.edit.cancel")}</Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {saving ? t("engineAdmin.people.edit.saving") : t("engineAdmin.people.edit.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
