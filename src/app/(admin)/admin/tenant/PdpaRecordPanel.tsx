"use client";
/**
 * PDPA (Thailand Personal Data Protection Act) processing record — a single
 * tenant-wide summary of what personal data this workspace processes, why,
 * and under what legal basis. Deliberately ONE record, not a multi-activity
 * register (see the plan's "explicitly out of scope") — matches how
 * brandJson/briefConfigJson already model "one blob of settings per tenant".
 *
 * Not tier-gated — record-keeping for a legal obligation isn't a paid
 * feature, same reasoning as CurrencyPanel/RegionPanel.
 */
import { useState } from "react";
import { Loader2, Save, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { useToast } from "@/lib/toast";
import { useT } from "@/lib/i18n/LocaleContext";

export type PdpaRecord = {
  controllerName?: string;
  dpoContact?: string;
  dataCategories: string[];
  purposeOfProcessing: string;
  legalBasis:
    | "consent" | "contract" | "legal_obligation"
    | "vital_interest" | "public_task" | "legitimate_interest";
  retentionPeriod: string;
  thirdPartySharing?: string;
  lastReviewedAt?: string;
};

const LEGAL_BASES: PdpaRecord["legalBasis"][] = [
  "consent", "contract", "legal_obligation", "vital_interest", "public_task", "legitimate_interest",
];

const EMPTY: PdpaRecord = {
  dataCategories: [],
  purposeOfProcessing: "",
  legalBasis: "legitimate_interest",
  retentionPeriod: "",
};

export function PdpaRecordPanel({ initial, tenantName, region }: {
  initial: PdpaRecord | null;
  tenantName: string;
  region: string | null;
}) {
  const { t } = useT();
  const { push } = useToast();
  const [record, setRecord] = useState<PdpaRecord>(initial ?? EMPTY);
  const [categoriesText, setCategoriesText] = useState((initial?.dataCategories ?? []).join(", "));
  const [saving, setSaving] = useState(false);

  function set<K extends keyof PdpaRecord>(key: K, value: PdpaRecord[K]) {
    setRecord((r) => ({ ...r, [key]: value }));
  }

  async function save() {
    setSaving(true);
    try {
      const dataCategories = categoriesText.split(",").map((s) => s.trim()).filter(Boolean);
      const r = await fetch("/api/admin/tenant/pdpa", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...record, dataCategories }),
      });
      if (!r.ok) {
        const msg = (await r.json().catch(() => null))?.error ?? t("adminTenant.pdpa.saveFailed");
        push({ variant: "destructive", title: t("adminTenant.pdpa.saveFailed"), description: msg });
        return;
      }
      const updated: PdpaRecord = await r.json();
      setRecord(updated);
      setCategoriesText(updated.dataCategories.join(", "));
      push({ variant: "success", title: t("adminTenant.pdpa.saved"), description: t("adminTenant.pdpa.savedHint") });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mb-8 rounded-lg border bg-card p-5 shadow-xs">
      <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5" /> {t("adminTenant.pdpa.title")}
      </p>
      <p className="mb-4 text-xs text-muted-foreground">
        {region === "th" ? t("adminTenant.pdpa.hintThailand") : t("adminTenant.pdpa.hintGeneric")}
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="pdpa-controller">{t("adminTenant.pdpa.controllerName")}</Label>
          <Input
            id="pdpa-controller"
            placeholder={tenantName}
            value={record.controllerName ?? ""}
            onChange={(e) => set("controllerName", e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="pdpa-dpo">{t("adminTenant.pdpa.dpoContact")}</Label>
          <Input
            id="pdpa-dpo"
            value={record.dpoContact ?? ""}
            onChange={(e) => set("dpoContact", e.target.value)}
          />
        </div>
      </div>

      <div className="mt-4 grid gap-1.5">
        <Label htmlFor="pdpa-categories">{t("adminTenant.pdpa.dataCategories")}</Label>
        <textarea
          id="pdpa-categories"
          rows={2}
          className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          placeholder={t("adminTenant.pdpa.dataCategoriesPlaceholder")}
          value={categoriesText}
          onChange={(e) => setCategoriesText(e.target.value)}
        />
      </div>

      <div className="mt-4 grid gap-1.5">
        <Label htmlFor="pdpa-purpose">{t("adminTenant.pdpa.purpose")}</Label>
        <textarea
          id="pdpa-purpose"
          rows={2}
          className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          value={record.purposeOfProcessing}
          onChange={(e) => set("purposeOfProcessing", e.target.value)}
        />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="pdpa-basis">{t("adminTenant.pdpa.legalBasis")}</Label>
          <Select value={record.legalBasis} onValueChange={(v) => set("legalBasis", v as PdpaRecord["legalBasis"])}>
            <SelectTrigger id="pdpa-basis">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEGAL_BASES.map((b) => (
                <SelectItem key={b} value={b}>{t(`adminTenant.pdpa.legalBasis.${b}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="pdpa-retention">{t("adminTenant.pdpa.retentionPeriod")}</Label>
          <Input
            id="pdpa-retention"
            placeholder={t("adminTenant.pdpa.retentionPeriodPlaceholder")}
            value={record.retentionPeriod}
            onChange={(e) => set("retentionPeriod", e.target.value)}
          />
        </div>
      </div>

      <div className="mt-4 grid gap-1.5">
        <Label htmlFor="pdpa-sharing">{t("adminTenant.pdpa.thirdPartySharing")}</Label>
        <Input
          id="pdpa-sharing"
          value={record.thirdPartySharing ?? ""}
          onChange={(e) => set("thirdPartySharing", e.target.value)}
        />
      </div>

      <div className="mt-5 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {record.lastReviewedAt
            ? t("adminTenant.pdpa.lastReviewed").replace("{date}", new Date(record.lastReviewedAt).toLocaleDateString())
            : t("adminTenant.pdpa.neverReviewed")}
        </p>
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
          {t("adminTenant.pdpa.save")}
        </Button>
      </div>
    </section>
  );
}
