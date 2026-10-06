"use client";
/**
 * Workspace time zone panel — an admin's default for "morning" where a
 * member hasn't set their own (today, only the Strategist's results check,
 * lib/executive/strategistResults.ts, reads it). Not tier-gated, same
 * reasoning as CurrencyPanel/RegionPanel: a correctness setting, not a
 * paid feature. Free-text IANA name (no curated list exists yet, unlike
 * currency/region) — validated server-side by lib/preferences/lineBrief's
 * validTz, and here against the browser's own Intl support before saving.
 */
import { useState } from "react";
import { Loader2, Save, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/lib/toast";
import { useT } from "@/lib/i18n/LocaleContext";

function isValidTz(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

export function TimezonePanel({ initial }: { initial: string | null }) {
  const { t } = useT();
  const { push } = useToast();
  const [tz, setTz] = useState(initial ?? "");
  const [saving, setSaving] = useState(false);

  const browserTz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : null;
  const trimmed = tz.trim();
  const invalid = trimmed !== "" && !isValidTz(trimmed);

  async function save() {
    setSaving(true);
    try {
      const r = await fetch("/api/admin/tenant", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: trimmed }),
      });
      if (!r.ok) {
        const msg = (await r.json().catch(() => null))?.error ?? t("adminTenant.timezone.saveFailed");
        push({ variant: "destructive", title: t("adminTenant.timezone.saveFailed"), description: msg });
        return;
      }
      push({ variant: "success", title: t("adminTenant.timezone.saved"), description: t("adminTenant.timezone.savedHint") });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mb-8 rounded-lg border bg-card p-5 shadow-xs">
      <p className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Clock className="h-3.5 w-3.5" /> {t("adminTenant.timezone.title")}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="tz">{t("adminTenant.timezone.label")}</Label>
          <Input id="tz" className="w-64" placeholder={browserTz ?? "Asia/Bangkok"} value={tz} onChange={(e) => setTz(e.target.value)} />
        </div>
        <Button size="sm" onClick={save} disabled={saving || invalid || trimmed === (initial ?? "")}>
          {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
          {t("adminTenant.timezone.save")}
        </Button>
        {browserTz && trimmed !== browserTz && (
          <button type="button" onClick={() => setTz(browserTz)} className="text-xs text-primary-ink hover:underline">
            {t("adminTenant.timezone.useBrowser").replace("{tz}", browserTz)}
          </button>
        )}
      </div>
      {invalid && <p className="mt-2 text-xs text-destructive">{t("adminTenant.timezone.invalid")}</p>}
      <p className="mt-3 text-xs text-muted-foreground">{t("adminTenant.timezone.hint")}</p>
    </section>
  );
}
