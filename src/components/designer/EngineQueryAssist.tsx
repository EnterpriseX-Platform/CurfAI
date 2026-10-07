"use client";
/**
 * "Describe what you want", at the top of the engine query editor. The person says it in words; the server asks a
 * model for a query on a view they may use (it sees names and types, never data), checks the answer against the
 * catalogue, and sends it back with any problems. Only a suggestion with no problems can be used, and using it
 * only fills in the editor below: the person previews it, as themselves, before saving anything.
 */
import { useId, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/lib/i18n/LocaleContext";
import type { EngineQuery } from "@/lib/reporting/schema";

type Problem = { field: string; key: string; values?: Record<string, string | number> };
type Suggestion = { query: EngineQuery; explanation: string; view: { id: string; name: string }; problems: Problem[]; usable: boolean };
type Result = { kind: "suggestion"; suggestion: Suggestion } | { kind: "error"; message: string } | { kind: "applied" };

const fill = (text: string, values?: Record<string, string | number>) =>
  Object.entries(values ?? {}).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), text);

export function EngineQueryAssist({
  dataSourceId, parameterNames, hasQuery, onApply,
}: {
  dataSourceId: string;
  parameterNames: string[];
  /** A view is already chosen, so using a suggestion replaces what the author has built. */
  hasQuery: boolean;
  onApply: (query: EngineQuery) => void;
}) {
  const { t, locale } = useT();
  const id = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const ask = async () => {
    if (busy || text.trim().length < 3) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch("/api/engine/suggest-query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dataSourceId, request: text, parameters: parameterNames, locale }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok || !body?.suggestion) {
        setResult({ kind: "error", message: typeof body?.error === "string" ? body.error : t("engineQuery.assist.failed") });
      } else {
        setResult({ kind: "suggestion", suggestion: body.suggestion as Suggestion });
      }
    } catch {
      setResult({ kind: "error", message: t("engineQuery.assist.failed") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-2 rounded-md border bg-card p-3" data-testid="engine-query-assist">
      <h3 id={`${id}-title`} className="flex items-center gap-1.5 text-sm font-medium">
        <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" /> {t("engineQuery.assist.title")}
      </h3>
      <p className="text-xs text-muted-foreground">{t("engineQuery.assist.hint")}</p>
      <Label htmlFor={`${id}-text`} className="sr-only">{t("engineQuery.assist.label")}</Label>
      <Textarea
        id={`${id}-text`}
        rows={2}
        maxLength={500}
        value={text}
        placeholder={t("engineQuery.assist.placeholder")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void ask(); } }}
      />
      <div>
        <Button type="button" size="sm" onClick={() => void ask()} disabled={busy || text.trim().length < 3}>
          {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Sparkles className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />}
          {busy ? t("engineQuery.assist.working") : t("engineQuery.assist.button")}
        </Button>
      </div>

      <div role="status" aria-live="polite">
        {result?.kind === "error" && (
          <p className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs" role="alert">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" /> {result.message}
          </p>
        )}
        {result?.kind === "applied" && (
          <p className="flex items-center gap-1.5 text-xs text-success">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> {t("engineQuery.assist.applied")}
          </p>
        )}
        {result?.kind === "suggestion" && (
          <div className="grid gap-2 rounded-md border bg-muted/40 p-3 text-xs">
            {result.suggestion.explanation && <p className="text-sm text-foreground">{result.suggestion.explanation}</p>}
            <p className="text-muted-foreground">{fill(t("engineQuery.assist.view"), { name: result.suggestion.view.name })}</p>
            {result.suggestion.usable ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" size="sm" onClick={() => { onApply(result.suggestion.query); setResult({ kind: "applied" }); }}>
                  {t("engineQuery.assist.use")}
                </Button>
                {hasQuery && <span className="text-muted-foreground">{t("engineQuery.assist.replaces")}</span>}
              </div>
            ) : (
              <div className="grid gap-1">
                <p className="font-medium text-foreground">{t("engineQuery.assist.notFit")}</p>
                <ul className="list-disc pl-5 text-muted-foreground">
                  {result.suggestion.problems.map((p, i) => <li key={i}>{fill(t(p.key), p.values)}</li>)}
                </ul>
                <p className="text-muted-foreground">{t("engineQuery.assist.tryAgain")}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
