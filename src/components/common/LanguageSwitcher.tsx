"use client";
import { Globe } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "@/lib/i18n/LocaleContext";
import { LOCALES, LOCALE_LABELS, LOCALE_FLAGS } from "@/lib/i18n/dict";

export function LanguageSwitcher({
  compact = false,
  onAccent = false,
}: {
  compact?: boolean;
  /**
   * Styles the trigger for a saturated brand background (the public app bar,
   * whose colour is tenant-supplied and so can't be predicted here) — a
   * translucent white pill instead of the default light-surface chip. The
   * menu itself is unchanged; it renders on its own popover surface.
   */
  onAccent?: boolean;
}) {
  const { locale, setLocale } = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={
            onAccent
              ? "inline-flex h-8 items-center gap-1.5 rounded-full border border-card/30 bg-card/10 px-3 text-xs font-semibold text-white hover:bg-card/20"
              : "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          }
          title="Language"
        >
          <Globe className={onAccent ? "h-3.5 w-3.5 text-white/80" : "h-3.5 w-3.5 text-muted-foreground"} />
          {compact ? LOCALE_FLAGS[locale] : LOCALE_LABELS[locale]}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        {LOCALES.map((l) => (
          <DropdownMenuItem key={l} onClick={() => setLocale(l)}>
            <span className="mr-2">{LOCALE_FLAGS[l]}</span>
            {LOCALE_LABELS[l]}
            {l === locale && <span className="ml-auto text-primary">•</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
