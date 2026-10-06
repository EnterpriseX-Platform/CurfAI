"use client";
/**
 * A block's {{param.x}} text, filled in for the reader: a date parameter
 * reads "1 มิ.ย. 2569" for a Thai reader (their era, or the report's locked
 * dateEra — DateStyleProvider). A client component so TitleBlock and
 * TextBlock can stay server components: the print=1 page behind PDF and
 * Excel exports renders them on the server, where a hook can't run.
 */
import { interpolate } from "@/lib/reporting/interpolate";
import { thaiDateLabel } from "@/lib/reporting/format";
import { useDateStyle } from "@/components/providers/DateStyleProvider";

export function InterpolatedText({ template, params }: { template: string; params?: Record<string, unknown> }) {
  const dateStyle = useDateStyle();
  return <>{interpolate(template, { params, display: (v) => thaiDateLabel(v, dateStyle) })}</>;
}
