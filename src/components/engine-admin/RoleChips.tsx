"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fill } from "@/lib/engine/fill";
import { addRole, type RoleSuggestion } from "@/lib/engine/viewForm";
import { Field } from "./adminUi";

/**
 * A list of roles: chips you can remove, suggestions you can click, and a box for any other role. The reserved
 * role `public` is refused here on purpose; it has its own step.
 */
export function RoleChips({ id, label, hint, values, onChange, suggestions }: {
  id: string; label: string; hint: string; values: string[]; onChange: (next: string[]) => void; suggestions: RoleSuggestion[];
}) {
  const { t } = useT();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = (value: string) => {
    const r = addRole(values, value);
    if (r.error) { setError(t(r.error)); return; }
    setError(null);
    setText("");
    if (r.roles !== values) onChange(r.roles);
  };

  const open = suggestions.filter((s) => !values.includes(s.value));
  return (
    <Field id={id} label={label} hint={hint} error={error ?? undefined}>
      {(a) => (
        <div className="space-y-2">
          {values.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5" aria-label={label}>
              {values.map((v) => (
                <li key={v} className="inline-flex items-center gap-1 rounded-sm bg-primary-soft py-0.5 pl-2 pr-1 text-xs font-medium text-primary">
                  <span className="font-mono">{v}</span>
                  <button
                    type="button"
                    onClick={() => onChange(values.filter((x) => x !== v))}
                    aria-label={fill(t("engineAdmin.views.roles.remove"), { role: v })}
                    className="rounded-sm p-0.5 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs italic text-faint">{t("engineAdmin.views.roles.none")}</p>
          )}
          <div className="flex gap-2">
            <Input
              {...a}
              value={text}
              onChange={(e) => { setText(e.target.value); setError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(text); } }}
              placeholder={t("engineAdmin.views.roles.placeholder")}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
            <Button type="button" variant="outline" onClick={() => add(text)} disabled={!text.trim()}>
              <Plus className="h-4 w-4" aria-hidden="true" /> {t("engineAdmin.views.roles.add")}
            </Button>
          </div>
          {open.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">{t("engineAdmin.views.roles.suggestions")}</span>
              {open.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => add(s.value)}
                  className="rounded-sm border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  + {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Field>
  );
}
