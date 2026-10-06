"use client";
/**
 * Workspace currency panel — sets the default currency every report's
 * KPI/chart/table/AI-narration falls back to when the report itself has no
 * currency override (see lib/reporting/currency.ts's resolution cascade).
 *
 * Deliberately its own panel, not folded into /admin/branding: that page is
 * Business-tier gated, and seeing your own currency correctly is a
 * correctness setting every tier needs, not a paid brand feature.
 */
import { useState } from "react";
import { Loader2, Save, Coins } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { useToast } from "@/lib/toast";
import { CURRENCY_OPTIONS, DEFAULT_CURRENCY } from "@/lib/reporting/currency";

export function CurrencyPanel({ initial }: { initial: string | null }) {
  const { push } = useToast();
  const [currency, setCurrency] = useState(initial ?? DEFAULT_CURRENCY);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const r = await fetch("/api/admin/tenant", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currency }),
      });
      if (!r.ok) {
        const msg = (await r.json().catch(() => null))?.error ?? "Save failed";
        push({ variant: "destructive", title: "Save failed", description: msg });
        return;
      }
      // resolveCurrency() reads Tenant.currency live on every render (report
      // override > tenant default > DEFAULT_CURRENCY) — it's never baked into a report
      // at creation time, so this genuinely applies to every existing
      // report/dashboard/AI answer that has no currency of its own, not
      // just ones created from now on. The description line below already
      // said that; this toast used to say the opposite ("New reports and
      // dashboards will show this currency by default"), which was simply
      // wrong about what the save actually does.
      push({ variant: "success", title: "Currency saved", description: "Applies immediately to every report, dashboard, and AI answer that doesn't set its own currency." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mb-8 rounded-lg border bg-card p-5 shadow-xs">
      <p className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Coins className="h-3.5 w-3.5" /> Currency
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="currency">Workspace default</Label>
          <Select value={currency} onValueChange={setCurrency}>
            <SelectTrigger id="currency" className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CURRENCY_OPTIONS.map((c) => (
                <SelectItem key={c.code} value={c.code}>{c.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button size="sm" onClick={save} disabled={saving || currency === (initial ?? DEFAULT_CURRENCY)}>
          {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
          Save
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Applies to every report, dashboard, and AI answer in this workspace that formats a value as currency.
      </p>
    </section>
  );
}
