"use client";
/**
 * SeriesLabelsEditor — bespoke UI for ChartConfigSchema.seriesLabels: one box
 * per Y field for what the legend and tooltip call it, the name it gets
 * without one (seriesName) as the placeholder. Clearing a box drops that
 * field's name; clearing them all drops the map from the saved JSON.
 */
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n/LocaleContext";
import { seriesName } from "@/components/blocks/charts/shared";

export function SeriesLabelsEditor({
  value, yFields, onChange,
}: {
  value: Record<string, string> | undefined;
  yFields: string[];
  onChange: (next: Record<string, string> | undefined) => void;
}) {
  const { t } = useT();
  if (yFields.length === 0) return <p className="text-[11px] text-muted-foreground">{t("propertyPanel.seriesLabels.none")}</p>;
  const set = (field: string, text: string) => {
    const next = { ...value };
    if (text.trim()) next[field] = text;
    else delete next[field];
    onChange(Object.keys(next).length ? next : undefined);
  };
  return (
    <div className="grid gap-1.5">
      {yFields.map((f) => (
        <div key={f} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-2">
          <span className="truncate font-mono text-[11px] text-muted-foreground" title={f}>{f}</span>
          <Input value={value?.[f] ?? ""} placeholder={seriesName(f)} onChange={(e) => set(f, e.target.value)} aria-label={f} />
        </div>
      ))}
      <p className="text-[11px] leading-snug text-muted-foreground">{t("propertyPanel.seriesLabels.hint")}</p>
    </div>
  );
}
