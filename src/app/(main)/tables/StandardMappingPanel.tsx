"use client";
/**
 * Which column of the uploaded file is which field of a standard dataset
 * (sales_lines / inventory — lib/lake/standardDatasets.ts). The server
 * suggests a mapping (POST /api/lake/uploads/[id]/mapping: header names,
 * checked against the values, or the mapping confirmed for this same file
 * layout last time); this panel shows it field by field for the user to
 * confirm or correct, and reports back what would be imported.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, Sparkles } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DateOrderToggle } from "./DateOrderToggle";

export type StandardTarget = "sales_lines" | "inventory";
export type FieldSource = { column: string } | { value: string };
export type StandardMappingState = {
  mapping: Record<string, FieldSource>;
  /** Day/month order of each source date column the mapping uses. */
  dateOrders: Record<string, "mdy" | "dmy">;
  /** Nothing required is missing, and the workspace can take the import. */
  ready: boolean;
};

type Field = {
  key: string;
  type: "text" | "number" | "date";
  required?: boolean;
  requiredGroup?: string;
  allowFixed?: boolean;
  derivedFrom?: string[];
};

type MappingResponse = {
  dataset: { id: StandardTarget; tableName: string; exists: boolean; fields: Field[] };
  columns: Array<{ name: string; samples: string[] }>;
  mapping: Record<string, FieldSource>;
  origin: Record<string, "saved" | "name" | "filename">;
  dateOrders: Record<string, { order: "mdy" | "dmy"; ambiguous: boolean }>;
  savedFrom: string | null;
  blocked: string | null;
};

const NONE = "__none__";
const FIXED = "__value__";

/** Required fields (and item groups) the mapping still leaves empty. */
function missingFields(fields: Field[], mapping: Record<string, FieldSource>): string[] {
  const derived = (f: Field) => !!f.derivedFrom && f.derivedFrom.every((k) => !!mapping[k]);
  const filled = (f: Field) => {
    const src = mapping[f.key];
    return !!src && ("column" in src || src.value.trim() !== "");
  };
  const missing = fields.filter((f) => f.required && !filled(f) && !derived(f)).map((f) => f.key);
  const groups = [...new Set(fields.map((f) => f.requiredGroup).filter((g): g is string => !!g))];
  for (const g of groups) {
    const members = fields.filter((f) => f.requiredGroup === g);
    if (!members.some(filled)) missing.push(members.map((f) => f.key).join("|"));
  }
  return missing;
}

export function StandardMappingPanel({
  uploadId, dataset, sheet, textRepair, disabled, onChange,
}: {
  uploadId: string;
  dataset: StandardTarget;
  sheet: string | null;
  textRepair: "mac_roman" | "cp1252" | null;
  disabled?: boolean;
  onChange: (state: StandardMappingState) => void;
}) {
  const { t } = useT();
  const [data, setData] = useState<MappingResponse | null>(null);
  const [mapping, setMapping] = useState<Record<string, FieldSource>>({});
  const [dateOrders, setDateOrders] = useState<Record<string, "mdy" | "dmy">>({});
  const [error, setError] = useState<string | null>(null);
  // "Ask AI": which fields it filled (to label them), and how the last ask went.
  const [aiFields, setAiFields] = useState<Record<string, FieldSource>>({});
  const [asking, setAsking] = useState(false);
  const [aiNote, setAiNote] = useState<string | null>(null);
  // The fetch below runs per upload/dataset, not per render — read the
  // current translator through a ref rather than re-fetching when it changes.
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    let cancelled = false;
    setData(null); setError(null);
    (async () => {
      const r = await fetch(`/api/lake/uploads/${uploadId}/mapping`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataset, sheet: sheet ?? undefined, textRepair }),
      });
      const j = await r.json().catch(() => ({}));
      if (cancelled) return;
      if (!r.ok) { setError(j?.error ?? `Server returned ${r.status}`); return; }
      const res = j as MappingResponse;
      setData(res);
      setMapping(res.mapping);
      setDateOrders(Object.fromEntries(Object.entries(res.dateOrders).map(([k, v]) => [k, v.order])));
    })().catch((e) => { if (!cancelled) setError(e?.message ?? tRef.current("tables.upload.failedFallback")); });
    return () => { cancelled = true; };
  }, [uploadId, dataset, sheet, textRepair]);

  const label = (key: string) => t(`tables.std.field.${key}`);
  const missing = useMemo(() => (data ? missingFields(data.dataset.fields, mapping) : []), [data, mapping]);

  useEffect(() => {
    if (!data) { onChange({ mapping: {}, dateOrders: {}, ready: false }); return; }
    const used = new Set(Object.values(mapping).filter((s): s is { column: string } => "column" in s).map((s) => s.column));
    onChange({
      mapping,
      dateOrders: Object.fromEntries(Object.entries(dateOrders).filter(([col]) => used.has(col))),
      ready: missing.length === 0 && !data.blocked,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- report state changes, not the callback's identity
  }, [data, mapping, dateOrders, missing]);

  if (error) {
    return (
      <div className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
        <span>{error}</span>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border px-3 py-6 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("tables.import.mapping.loading")}
      </div>
    );
  }

  const samplesOf = (col: string) => data.columns.find((c) => c.name === col)?.samples ?? [];
  const setField = (key: string, src: FieldSource | null) =>
    setMapping((cur) => {
      const next = { ...cur };
      if (src) next[key] = src; else delete next[key];
      return next;
    });

  // Worth asking only while a field is open and a column is still free.
  const usedColumns = new Set(Object.values(mapping).flatMap((s) => ("column" in s ? [s.column] : [])));
  const canAskAi = data.dataset.fields.some((f) => !mapping[f.key]) && data.columns.some((c) => !usedColumns.has(c.name));

  async function askAi() {
    setAsking(true); setAiNote(null);
    try {
      const r = await fetch(`/api/lake/uploads/${uploadId}/mapping`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataset, sheet: sheet ?? undefined, textRepair, ai: { current: mapping } }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error ?? `Server returned ${r.status}`);
      const got = (j.aiSuggestions ?? {}) as Record<string, FieldSource>;
      if (j.aiError) setAiNote(t("tables.import.mapping.aiError").replace("{error}", j.aiError));
      else if (Object.keys(got).length === 0) setAiNote(t("tables.import.mapping.aiNone"));
      // Only fills what is still open — never overwrites the user's own choice.
      setMapping((cur) => ({ ...Object.fromEntries(Object.entries(got).filter(([k]) => !cur[k])), ...cur }));
      setAiFields((cur) => ({ ...cur, ...got }));
    } catch (e: any) {
      setAiNote(t("tables.import.mapping.aiError").replace("{error}", e?.message ?? ""));
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="space-y-2">
      {data.blocked && (
        <div className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{data.blocked}</span>
        </div>
      )}
      {data.savedFrom !== null && (
        <p className="rounded-md bg-primary-soft px-3 py-2 text-[11px] text-primary">
          {t("tables.import.mapping.savedFrom").replace("{file}", data.savedFrom || "—")}
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">
        {t(data.dataset.exists ? `tables.import.target.replaceNote.${dataset}` : `tables.import.target.hint.${dataset}`)}
      </p>

      {(canAskAi || aiNote) && (
        <div className="flex flex-wrap items-center gap-2">
          {canAskAi && (
            <button
              type="button"
              onClick={() => void askAi()}
              disabled={disabled || asking}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-muted disabled:opacity-50"
            >
              {asking ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3 text-primary" />}
              {t(asking ? "tables.import.mapping.askingAi" : "tables.import.mapping.askAi")}
            </button>
          )}
          {aiNote && <span className="text-[11px] text-muted-foreground">{aiNote}</span>}
        </div>
      )}

      <div className="max-h-[45vh] overflow-y-auto rounded-md border border-border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-muted text-[10px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">{t("tables.import.mapping.field")}</th>
              <th className="px-3 py-2 text-left font-medium">{t("tables.import.mapping.fromFile")}</th>
              <th className="px-3 py-2 text-left font-medium">{t("tableDetail.colHeaderSample")}</th>
            </tr>
          </thead>
          <tbody>
            {data.dataset.fields.map((f) => {
              const src = mapping[f.key];
              const selectValue = !src ? NONE : "value" in src ? FIXED : `col:${src.column}`;
              const derived = !src && !!f.derivedFrom && f.derivedFrom.every((k) => !!mapping[k]);
              const same = (a?: FieldSource) => !!src && JSON.stringify(a) === JSON.stringify(src);
              const origin = same(aiFields[f.key]) ? "ai" : data.origin[f.key] && same(data.mapping[f.key]) ? data.origin[f.key] : null;
              const sample = src && "column" in src ? samplesOf(src.column)[0] : undefined;
              const isMissing = missing.includes(f.key) || missing.some((m) => m.split("|").includes(f.key));
              return (
                <tr key={f.key} className="border-t border-border align-top">
                  <td className="px-3 py-1.5">
                    <div className="font-medium">{label(f.key)}</div>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {(f.required || f.requiredGroup) && (
                        <span className={"rounded px-1 text-[10px] " + (isMissing ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>
                          {t(f.requiredGroup ? "tables.import.mapping.requiredOne" : "tables.import.mapping.required")}
                        </span>
                      )}
                      <span className="font-mono text-[10px] text-faint">{f.key}</span>
                    </div>
                  </td>
                  <td className="px-3 py-1.5">
                    <Select
                      value={selectValue}
                      disabled={disabled}
                      onValueChange={(v) => setField(f.key, v === NONE ? null : v === FIXED ? { value: "" } : { column: v.slice(4) })}
                    >
                      <SelectTrigger className="h-7 w-44 text-[11px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE} className="text-[11px]">{t("tables.import.mapping.notInFile")}</SelectItem>
                        {f.allowFixed && <SelectItem value={FIXED} className="text-[11px]">{t("tables.import.mapping.typeValue")}</SelectItem>}
                        {data.columns.map((c) => (
                          <SelectItem key={c.name} value={`col:${c.name}`} className="text-[11px]">{c.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {src && "value" in src && (
                      <input
                        value={src.value}
                        disabled={disabled}
                        onChange={(e) => setField(f.key, { value: e.target.value })}
                        placeholder={t(`tables.import.mapping.valuePlaceholder.${f.type === "date" ? "date" : "text"}`)}
                        className="mt-1 h-7 w-44 rounded-md border border-border bg-background px-2 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                    )}
                    {src && "column" in src && f.type === "date" && (
                      <DateOrderToggle
                        value={dateOrders[src.column] ?? "dmy"}
                        unproven={!!data.dateOrders[src.column]?.ambiguous}
                        onChange={(v) => setDateOrders((cur) => ({ ...cur, [src.column]: v }))}
                      />
                    )}
                    {origin && (
                      <div className="mt-0.5 text-[10px] text-muted-foreground">
                        {t("tables.import.mapping.origin." + origin)}
                      </div>
                    )}
                    {derived && (
                      <div className="mt-0.5 text-[10px] text-success">
                        {f.key === "sale_time"
                          ? t("tables.import.mapping.derivedTime")
                          : t("tables.import.mapping.derived").replace("{fields}", f.derivedFrom!.map(label).join(" × "))}
                      </div>
                    )}
                  </td>
                  <td className="max-w-[12rem] truncate px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                    {sample ?? ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {missing.length > 0 && (
        <p className="text-[11px] text-destructive">
          {t("tables.import.mapping.missing").replace(
            "{fields}",
            missing.map((m) => m.split("|").map(label).join(t("tables.import.mapping.or"))).join(", "),
          )}
        </p>
      )}
    </div>
  );
}
