"use client";
/**
 * Workspace region panel — a self-declared jurisdiction, NOT a data-
 * residency guarantee (deployment stays single-region regardless). Read by
 * PdpaRecordPanel to decide whether to show Thailand-specific guidance.
 *
 * Mirrors CurrencyPanel.tsx's shape exactly — same reasoning for being its
 * own panel rather than folded into /admin/branding (Business-tier gated;
 * this isn't a paid feature).
 */
import { useState } from "react";
import { Loader2, Save, Globe2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { useToast } from "@/lib/toast";
import { REGION_OPTIONS } from "@/lib/tenantRegion";
import { useT } from "@/lib/i18n/LocaleContext";

export function RegionPanel({ initial }: { initial: string | null }) {
  const { t } = useT();
  const { push } = useToast();
  const [region, setRegion] = useState(initial ?? "global");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const r = await fetch("/api/admin/tenant", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region }),
      });
      if (!r.ok) {
        const msg = (await r.json().catch(() => null))?.error ?? t("adminTenant.region.saveFailed");
        push({ variant: "destructive", title: t("adminTenant.region.saveFailed"), description: msg });
        return;
      }
      push({ variant: "success", title: t("adminTenant.region.saved"), description: t("adminTenant.region.savedHint") });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mb-8 rounded-lg border bg-card p-5 shadow-xs">
      <p className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Globe2 className="h-3.5 w-3.5" /> {t("adminTenant.region.title")}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="region">{t("adminTenant.region.label")}</Label>
          <Select value={region} onValueChange={setRegion}>
            <SelectTrigger id="region" className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REGION_OPTIONS.map((r) => (
                <SelectItem key={r.code} value={r.code}>{r.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button size="sm" onClick={save} disabled={saving || region === (initial ?? "global")}>
          {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
          {t("adminTenant.region.save")}
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {t("adminTenant.region.hint")}
      </p>
    </section>
  );
}
