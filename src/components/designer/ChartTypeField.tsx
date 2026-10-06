"use client";
/**
 * Bespoke chartType editor for PropertyPanel — replaces the generic
 * enum-driven <Select> (which just listed all 12 values as plain text, no
 * icons, no grouping, no feedback about whether a type would even render
 * given the block's current xField/yFields) with the same grouped,
 * compatibility-aware picker ChartBlock's toolbar selector uses.
 *
 * Unlike the toolbar selector this one persists — onChange goes straight to
 * updateBlockConfig via the caller, same as every other Field() branch.
 */
import { useMemo } from "react";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { profileColumns, type ChartTypeValue } from "@/lib/reporting/chartCompatibility";
import { CHART_TYPE_ICON, groupChartTypes } from "@/components/blocks/chartTypeOptions";
import type { Row } from "@/lib/reporting/interpolate";
import { useT } from "@/lib/i18n/LocaleContext";

export function ChartTypeField({
  value, onChange, xField, yFields, sizeField, rows,
}: {
  value: string;
  onChange: (v: string) => void;
  xField?: string;
  yFields?: string[];
  sizeField?: string;
  rows: Row[];
}) {
  const { t } = useT();
  const groups = useMemo(() => {
    const profiles = profileColumns(rows);
    return groupChartTypes({ xField, yFields, sizeField }, profiles);
  }, [rows, xField, yFields, sizeField]);

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent>
        {groups.map((group) => (
          <SelectGroup key={group.purpose}>
            <SelectLabel>{t(`chartPurpose.${group.purpose}`)}</SelectLabel>
            {group.items.map((item) => {
              const Icon = CHART_TYPE_ICON[item.value as ChartTypeValue];
              return (
                <SelectItem key={item.value} value={item.value} disabled={!item.eligible}>
                  <span
                    className="flex items-center"
                    style={{ pointerEvents: "auto" }}
                    title={item.eligible ? undefined : t(item.reasonKey)}
                  >
                    <Icon className="mr-2 h-3.5 w-3.5 shrink-0" />
                    {t(`chartType.${item.value}`)}
                  </span>
                </SelectItem>
              );
            })}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
