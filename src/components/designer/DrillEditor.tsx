"use client";
/**
 * DrillEditor — "When someone clicks a value" for a drillable block
 * (lib/reporting/drill.ts): nothing, the rows behind it (`drilldown`), or
 * the whole report filtered to it (`drillParam`). Replaces the raw
 * drilldown / drillParam / drillField fields the property panel would
 * otherwise generate. Every choice is picked from what the report has — its
 * queries, the :parameters their SQL reads, its filters, the table's
 * columns — so a saved drill always points at something real.
 */
import type { Parameter, Report } from "@/lib/reporting/schema";
import { extractSqlParamNames } from "@/lib/reporting/params";
import { localizeParameter } from "@/lib/reporting/localize";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/lib/i18n/LocaleContext";
import { ColumnsEditor } from "./ColumnsEditor";

type DrillConfig = {
  queryId?: string;
  drilldown?: { queryId: string; filterParam?: string; title?: string; columns?: Array<{ key: string; label: string; type: string }> };
  drillParam?: string;
  drillField?: string;
  columns?: Array<{ key: string; label?: string; type?: string }>;
};
type Mode = "none" | "rows" | "filter";
const NO_FILTER = "__all__";

export function DrillEditor({
  blockType, config, report, onChange,
}: {
  blockType: string;
  config: DrillConfig;
  report: Pick<Report, "dataSources" | "parameters">;
  /** A partial config patch; `undefined` removes the field. */
  onChange: (patch: Partial<Record<"drilldown" | "drillParam" | "drillField", unknown>>) => void;
}) {
  const { t, locale } = useT();
  const isKpi = blockType === "kpi";
  // A heatmap drills from its tiles, and only by filter (HeatmapBlock).
  const isHeatmap = blockType === "heatmap";
  const mode: Mode = config.drillParam && !isKpi ? "filter" : config.drilldown ? "rows" : "none";
  const params: Parameter[] = report.parameters.map((p) => localizeParameter(p, locale));
  // Any query but the block's own: the drill shows something the block doesn't.
  const queries = report.dataSources.filter((d) => d.id !== config.queryId);
  const target = report.dataSources.find((d) => d.id === config.drilldown?.queryId);
  const targetParams = target?.sql ? extractSqlParamNames(target.sql) : [];

  const setMode = (m: Mode) => {
    if (m === "none") onChange({ drilldown: undefined, drillParam: undefined, drillField: undefined });
    else if (m === "filter") onChange({ drilldown: undefined, drillParam: params[0]?.name });
    else {
      const q = queries[0];
      const filterParam = isKpi || !q?.sql ? undefined : extractSqlParamNames(q.sql)[0];
      onChange({ drillParam: undefined, drilldown: q ? { queryId: q.id, ...(filterParam ? { filterParam } : {}) } : undefined });
    }
  };
  const setDrilldown = (patch: Partial<NonNullable<DrillConfig["drilldown"]>>) => {
    const next = { ...config.drilldown!, ...patch };
    for (const k of Object.keys(next) as Array<keyof typeof next>) if (next[k] === undefined || next[k] === "") delete next[k];
    onChange({ drilldown: next });
  };
  const textColumns = (config.columns ?? []).filter((c) => c.key);

  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <Label>{t("drill.editor.when")}</Label>
        <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{t("drill.editor.none")}</SelectItem>
            {!isHeatmap && <SelectItem value="rows" disabled={queries.length === 0}>{t(isKpi ? "drill.editor.rowsKpi" : "drill.editor.rows")}</SelectItem>}
            {!isKpi && <SelectItem value="filter" disabled={params.length === 0}>{t("drill.editor.filter")}</SelectItem>}
          </SelectContent>
        </Select>
        {mode === "none" && !isKpi && params.length === 0 && (
          <p className="text-[11px] leading-snug text-muted-foreground">{t("drill.editor.noParams")}</p>
        )}
      </div>

      {mode === "filter" && (
        <div className="grid gap-1">
          <Label>{t("drill.editor.param")}</Label>
          <Select value={config.drillParam ?? ""} onValueChange={(v) => onChange({ drillParam: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {params.map((p) => <SelectItem key={p.name} value={p.name}>{p.label || p.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <p className="text-[11px] leading-snug text-muted-foreground">{t(isHeatmap ? "drill.editor.filterHintTiles" : "drill.editor.filterHint")}</p>
        </div>
      )}

      {mode === "rows" && config.drilldown && (
        <>
          <div className="grid gap-1">
            <Label>{t("drill.editor.query")}</Label>
            <Select value={config.drilldown.queryId} onValueChange={(v) => {
              const q = report.dataSources.find((d) => d.id === v);
              const names = q?.sql ? extractSqlParamNames(q.sql) : [];
              const keep = config.drilldown?.filterParam && names.includes(config.drilldown.filterParam) ? config.drilldown.filterParam : undefined;
              setDrilldown({ queryId: v, filterParam: isKpi ? undefined : keep ?? names[0] });
            }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {queries.map((q) => <SelectItem key={q.id} value={q.id}>{q.name || q.id}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {!isKpi && (
            <div className="grid gap-1">
              <Label>{t("drill.editor.filterParam")}</Label>
              <Select value={config.drilldown.filterParam ?? NO_FILTER} onValueChange={(v) => setDrilldown({ filterParam: v === NO_FILTER ? undefined : v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_FILTER}>{t("drill.editor.noFilter")}</SelectItem>
                  {targetParams.map((n) => <SelectItem key={n} value={n}><span className="font-mono">:{n}</span></SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-[11px] leading-snug text-muted-foreground">
                {targetParams.length === 0 ? t("drill.editor.noSqlParams") : t("drill.editor.filterParamHint")}
              </p>
            </div>
          )}
          <div className="grid gap-1">
            <Label>{t("drill.editor.title")}</Label>
            <Input value={config.drilldown.title ?? ""} placeholder={target?.name ?? ""} onChange={(e) => setDrilldown({ title: e.target.value })} />
          </div>
          <div className="grid gap-1">
            <Label>{t("drill.editor.columns")}</Label>
            <ColumnsEditor value={(config.drilldown.columns ?? []) as any} onChange={(cols: any[]) => setDrilldown({ columns: cols.length ? cols : undefined })} />
            <p className="text-[11px] leading-snug text-muted-foreground">{t("drill.editor.columnsHint")}</p>
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">{t("drill.editor.rowsHint")}</p>
        </>
      )}

      {blockType === "table" && mode !== "none" && (
        <div className="grid gap-1">
          <Label>{t("drill.editor.field")}</Label>
          <Select value={config.drillField ?? NO_FILTER} onValueChange={(v) => onChange({ drillField: v === NO_FILTER ? undefined : v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_FILTER}>{t("drill.editor.fieldDefault")}</SelectItem>
              {textColumns.map((c) => <SelectItem key={c.key} value={c.key}>{c.label || c.key}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}
