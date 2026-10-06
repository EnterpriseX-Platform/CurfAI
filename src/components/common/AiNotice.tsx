"use client";
/**
 * "Curf is AI and can make mistakes" — said wherever the product shows
 * something a model wrote or chose: under every box you ask Curf in, under an
 * answer, a memo, a generated report or a narrative. One component, one set
 * of words (ai.notice / ai.notice.short), so the promise reads the same
 * everywhere. Documents that leave the app (the Strategist paper, its PDF,
 * Word and deck) print the same ai.notice text themselves.
 *
 *   <AiNotice />            the full sentence, as its own line
 *   <AiNotice short />      "AI-written · can make mistakes", for tight spots
 */
import { Sparkles } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";
import { cn } from "@/lib/utils";

export function AiNotice({ short = false, className }: { short?: boolean; className?: string }) {
  const { t } = useT();
  return (
    <p className={cn("m-0 inline-flex items-start gap-1.5 text-[11px] leading-snug text-faint", className)}>
      <Sparkles className="mt-px h-3 w-3 shrink-0" aria-hidden />
      <span>{t(short ? "ai.notice.short" : "ai.notice")}</span>
    </p>
  );
}
