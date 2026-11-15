"use client";
import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/LocaleContext";

type AiStatus = { metered: boolean; trial: boolean; allowance?: number; remaining?: number; resetsAt?: string };

/**
 * What is left of this month's AI credits, and, on a trial model, that it is one. Shown to every role, not just the
 * admins who can open the billing page: the person spending the credits is the one who needs the number.
 */
export function AiCreditsChip() {
  const { t } = useT();
  const [s, setS] = useState<AiStatus | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/me/ai-status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j?.metered) setS(j); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  if (!s || s.remaining == null || s.allowance == null) return null;

  const low = s.remaining <= s.allowance * 0.1;
  const date = s.resetsAt ? s.resetsAt.slice(0, 10) : "";
  const credits = t("aiStatus.creditsLeft").replace("{n}", String(s.remaining)).replace("{total}", String(s.allowance));
  const hint = [s.trial ? t("aiStatus.trialHint") : "", t("aiStatus.resets").replace("{date}", date)].filter(Boolean).join(" ");
  return (
    <span
      title={hint}
      className={cn(
        "hidden h-7 shrink-0 items-center gap-1.5 rounded-md bg-muted px-2 text-xs sm:inline-flex",
        low ? "text-warning" : "text-muted-foreground",
      )}
    >
      <Sparkles className="h-3.5 w-3.5 shrink-0" />
      {s.trial && <span className="font-medium text-foreground">{t("aiStatus.trial")}</span>}
      <span className="font-mono">{credits}</span>
    </span>
  );
}
