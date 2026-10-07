"use client";
/**
 * What the pre-publish gate (lib/intelligence/reportGate.ts) checked and
 * changed on a generated report, for everyone who reads it: one quiet line
 * that says the report was checked, and — when anything was changed or
 * flagged — the list, in the reader's language. Renders nothing on a
 * report a person built (no `quality` stamp). A report a model wrote also
 * says "AI-written · can make mistakes" (ai.notice.short).
 */
import { useState } from "react";
import { ShieldCheck, ShieldAlert, ChevronDown } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";
import type { ReportQuality } from "@/lib/reporting/schema";

const fill = (s: string, vars: Record<string, string | number | undefined>) =>
  Object.entries(vars).reduce((out, [k, v]) => out.split(`{${k}}`).join(String(v ?? "")), s);

export function ReportQualityNote({ quality }: { quality: ReportQuality }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const changes = quality.changes ?? [];
  const flags = quality.flags ?? [];
  const notes = quality.notes ?? [];
  const count = changes.length + flags.length + notes.length;
  const Icon = quality.verdict === "pass" ? ShieldCheck : ShieldAlert;
  const tone = quality.verdict === "pass" ? "text-success" : "text-warning";

  const changeText = (c: ReportQuality["changes"][number]) => {
    const line = fill(t(`reportQuality.change.${c.kind}`), { title: c.title, to: c.to, n: c.n });
    const why = c.rule && t(`reportQuality.reason.${c.rule}`) !== `reportQuality.reason.${c.rule}` ? t(`reportQuality.reason.${c.rule}`) : null;
    return why && (c.kind === "removed" || c.kind === "adjusted") ? `${line} — ${why}` : line;
  };

  return (
    <div className="border-b border-border bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => count > 0 && setOpen((o) => !o)}
        className="flex w-full items-center gap-2 text-left disabled:cursor-default"
        disabled={count === 0}
        aria-expanded={open}
        title={new Date(quality.checkedAt).toLocaleString()}
      >
        <Icon className={`h-3.5 w-3.5 shrink-0 ${tone}`} />
        <span>{t(quality.reviewed ? "reportQuality.checkedByAi" : "reportQuality.checkedByRules")}</span>
        {/* A model wrote this report's words: say so, as everywhere else a model writes (ai.notice). */}
        {quality.authored === "ai" && (
          <>
            <span className="text-faint">·</span>
            <span>{t("ai.notice.short")}</span>
          </>
        )}
        {count > 0 && (
          <>
            <span className="text-faint">·</span>
            <span className="font-medium text-foreground">{fill(t("reportQuality.itemCount"), { n: count })}</span>
            <ChevronDown className={`ml-auto h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
          </>
        )}
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1 pb-1 pl-6">
          {changes.map((c, i) => <li key={`c${i}`}>{changeText(c)}</li>)}
          {flags.map((f, i) => <li key={`f${i}`}>{fill(t(`reportQuality.flag.${f.rule}`), { title: f.title })}</li>)}
          {notes.map((n, i) => <li key={`n${i}`} className="text-foreground">{n}</li>)}
        </ul>
      )}
    </div>
  );
}
