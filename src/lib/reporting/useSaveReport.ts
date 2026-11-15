"use client";
/**
 * Saving the report in the designer, and knowing whether there is anything unsaved. The Save button, the Publish review
 * and the leave guard all go through this one place. The saved copy lives in its own store, not the designer's: the
 * designer's store has an undo history, and moving the baseline must not become something Undo steps through.
 */
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { create } from "zustand";
import { useDesignerStore } from "@/lib/reporting/store";
import { useToast } from "@/lib/toast";
import { useT } from "@/lib/i18n/LocaleContext";

const useBaseline = create<{ json: string; set: (json: string) => void }>((set) => ({ json: "", set: (json) => set({ json }) }));

/** What the server holds now: set when the designer opens a report and after every save. */
export const markSaved = (report: unknown) => useBaseline.getState().set(JSON.stringify(report));

/** True once the open report differs from the saved one. */
export function useUnsaved(): boolean {
  const report = useDesignerStore((s) => s.report);
  const baseline = useBaseline((s) => s.json);
  return baseline !== "" && JSON.stringify(report) !== baseline;
}

export type SaveState = "idle" | "saving" | "saved" | "error";

export function useSaveReport(reportId: string) {
  const router = useRouter();
  const { push } = useToast();
  const { t } = useT();
  const [state, setState] = useState<SaveState>("idle");

  /** Saves the open report; true when the server took it. */
  const save = useCallback(async (): Promise<boolean> => {
    setState("saving");
    const report = useDesignerStore.getState().report;
    const res = await fetch("/api/reports/" + reportId, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ definition: report }),
    });
    if (!res.ok) {
      setState("error");
      // A tier-gated field (e.g. a non-default theme — see ThemeSection's
      // "click→save→toast is the upgrade nudge" design) fails here with a
      // structured 402 body, not plain text. The raw response text used to
      // get dumped straight into the toast; read it once, try to parse it
      // as the {error, upgradeUrl} shape the rest of the app uses, and fall
      // back to the raw text only when it genuinely isn't JSON.
      const raw = await res.text();
      let description = raw || t("common.requestFailed");
      try {
        const json = JSON.parse(raw);
        description = json?.upgradeUrl
          ? t("designerToolbar.upgradeAt")
              .replace("{error}", json.error ?? t("common.requestFailed"))
              .replace("{url}", json.upgradeUrl)
          : json?.error ?? description;
      } catch { /* not JSON — keep the raw text */ }
      push({ variant: "destructive", title: t("common.saveFailed"), description });
      return false;
    }
    markSaved(report);
    setState("saved");
    push({ variant: "success", title: t("common.saved"), description: t("designerToolbar.reportUpdated") });
    router.refresh();
    setTimeout(() => setState("idle"), 1500);
    return true;
  }, [reportId, push, t, router]);

  return { state, save };
}
