"use client";
/**
 * "Check" in the designer's right panel: what the report rules (the same list the pre-publish gate runs) say about the page
 * as it stands, block by block, in the author's language. A finding the gate can repair has a Fix button; a fix is one Undo.
 */
import { useMemo } from "react";
import { ShieldAlert, ShieldCheck, Wrench } from "lucide-react";
import { useDesignerStore } from "@/lib/reporting/store";
import { applyCheckFix, checkReport, type CheckItem } from "@/lib/reporting/designerCheck";
import type { Dataset } from "@/lib/reporting/interpolate";
import { Button } from "@/components/ui/button";
import { useToast } from "@/lib/toast";
import { useT } from "@/lib/i18n/LocaleContext";

const fill = (s: string, vars: Record<string, string | number | undefined>) =>
  Object.entries(vars).reduce((out, [k, v]) => out.split(`{${k}}`).join(String(v ?? "")), s);

/** A finding in the author's language: the gate's own flag text for its rule, else the rule's English detail. */
export function checkText(t: (key: string) => string, it: CheckItem): string {
  const key = `reportQuality.flag.${it.rule}`;
  const text = t(key);
  return text === key ? it.detail : fill(text, { title: it.title });
}

/** How many findings the report has now: the count on the panel's tab. */
export function useCheckItems(dataset: Dataset): CheckItem[] {
  const report = useDesignerStore((s) => s.report);
  return useMemo(() => {
    try { return checkReport(report, dataset as any); } catch { return []; }
  }, [report, dataset]);
}

export function CheckPanel({ items, dataset, onDataset }: { items: CheckItem[]; dataset: Dataset; onDataset: (d: Dataset) => void }) {
  const { t } = useT();
  const { push } = useToast();
  const selectBlock = useDesignerStore((s) => s.selectBlock);

  const fix = (it: CheckItem) => {
    const state = useDesignerStore.getState();
    const done = applyCheckFix(state.report, dataset as any, it.violation);
    if (!done) { push({ variant: "destructive", title: t("designerCheck.cannotFix") }); return; }
    state.replaceReport(done.report);
    onDataset(done.dataset as Dataset);
    push({ variant: "success", title: fill(t("designerCheck.fixed"), { title: done.title || it.title }), description: done.rerun ? t("designerCheck.runToSee") : t("designerCheck.undoHint") });
  };

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
        <ShieldCheck className="h-6 w-6 text-success" aria-hidden />
        <p className="text-sm font-medium">{t("designerCheck.clean")}</p>
        <p className="text-xs text-muted-foreground">{t("designerCheck.cleanNote")}</p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-border">
      {items.map((it, i) => (
        <li key={`${it.rule}-${it.blockId}-${i}`} className="flex flex-col gap-2 px-4 py-3">
          <div className="flex items-start gap-2">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
            <p className="text-[13px] leading-snug">{checkText(t, it)}</p>
          </div>
          <div className="flex items-center gap-2 pl-6">
            <span className="font-mono text-2xs text-faint">{it.rule}</span>
            {it.blockId && it.title && (
              <button type="button" onClick={() => selectBlock(it.blockId)} className="text-2xs text-primary hover:underline">
                {t("designerCheck.select")}
              </button>
            )}
            {it.fixable && (
              <Button size="sm" variant="outline" className="ml-auto h-7 gap-1 px-2 text-2xs" onClick={() => fix(it)}>
                <Wrench className="h-3 w-3" aria-hidden />{t("designerCheck.fix")}
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
