"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";
import { fill } from "@/lib/i18n/fill";
import { failedSyncs, type SyncResult } from "@/lib/engine/attributeView";

/**
 * What happened after a change was saved in Curf: the engine has it, or the engine could not be updated (the change
 * is still saved in Curf, and Sync retries it). Written out in words, with an icon, never colour alone.
 */
export function SyncNotice({ sync, savedKey }: { sync: SyncResult[] | undefined; savedKey: string }) {
  const { t } = useT();
  const failed = failedSyncs(sync);
  if (failed.length === 0) {
    return (
      <p className="flex items-start gap-2 text-sm text-foreground">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
        <span>{t(savedKey)}</span>
      </p>
    );
  }
  return (
    <div className="space-y-1">
      {failed.map((f) => (
        <p key={f.dataSourceId} className="flex items-start gap-2 text-sm text-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <span>{fill(t("engineAdmin.people.result.syncFailed"), { engine: f.name, error: f.error ?? t("engineAdmin.people.result.unknownError") })}</span>
        </p>
      ))}
    </div>
  );
}
