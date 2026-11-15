"use client";

import { useT } from "@/lib/i18n/LocaleContext";
import { UpgradeLock, isFeatureAvailable } from "@/components/common/UpgradeLock";
import { kindGroups } from "./kindChoices";
import { KIND_FEATURE, type DataSourceKind, type PickerKind } from "./types";

/** Step one of Add connection: pick what you are connecting, in plain words, before any field is shown. */
export function KindChooser({
  available, currentTier, onPick,
}: {
  available: (kind: PickerKind) => boolean;
  currentTier?: string;
  onPick: (kind: PickerKind) => void;
}) {
  const { t } = useT();
  return (
    <div className="grid gap-4 rounded-lg border bg-card p-5 shadow-xs" data-testid="kind-chooser">
      <p className="text-sm text-muted-foreground">{t("connectionForm.choose.lead")}</p>
      {kindGroups(available).map((g) => (
        <div key={g.id} className="grid gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t(g.titleKey)}</h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {g.choices.map((c) => {
              const feature = KIND_FEATURE[c.kind as DataSourceKind];
              const locked = !!feature && !isFeatureAvailable(currentTier, feature);
              return (
                <button
                  key={c.kind}
                  type="button"
                  onClick={() => onPick(c.kind)}
                  data-testid={`kind-${c.kind}`}
                  className="rounded-md border border-border bg-background p-3 text-left transition-colors hover:border-primary/50 hover:bg-primary-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    {t(c.labelKey)}
                    {locked && feature && <UpgradeLock feature={feature} currentTier={currentTier} variant="inline" />}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{t(c.hintKey)}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
