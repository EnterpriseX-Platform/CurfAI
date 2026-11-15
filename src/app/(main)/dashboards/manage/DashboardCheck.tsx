"use client";
/**
 * "Check" under a dashboard's reports in the manager: how the report check judged each report it shows, and whether the
 * layout puts too many on one screen. Runs as the reports are added and removed; the judging is lib/dashboards/check.ts.
 */
import { useEffect, useMemo, useState } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { checkDashboard, type ReportHealth } from "@/lib/dashboards/check";
import { parseSlotKey } from "@/lib/dashboards/slotKey";
import { useT } from "@/lib/i18n/LocaleContext";

export function DashboardCheck({ reportIds, layout }: { reportIds: string[]; layout: string }) {
  const { t } = useT();
  const [reports, setReports] = useState<Record<string, ReportHealth> | null>(null);
  // A card may be one block of a report: the check judges the report behind it, once.
  const ids = useMemo(() => [...new Set(reportIds.map((k) => parseSlotKey(k).reportId))], [reportIds]);
  const key = ids.join(",");

  useEffect(() => {
    if (!key) { setReports({}); return; }
    let live = true;
    fetch(`/api/dashboards/check?ids=${encodeURIComponent(key)}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live) setReports(j?.reports ?? null); })
      .catch(() => { if (live) setReports(null); });
    return () => { live = false; };
  }, [key]);

  const findings = useMemo(() => (reports ? checkDashboard({ reportIds: ids, cardCount: reportIds.length, reports, layout }) : []), [reports, ids, reportIds.length, layout]);
  // Nothing to say before the answer is in, and nothing to say for an empty dashboard.
  if (!reports || reportIds.length === 0) return null;

  const line = (f: (typeof findings)[number]): string => {
    const text = t(`dashboardCheck.${f.kind}`);
    return "name" in f ? text.split("{name}").join(f.name).split("{n}").join(String("n" in f ? f.n : "")) : text.split("{n}").join(String("n" in f ? f.n : ""));
  };

  if (findings.length === 0) {
    return <p className="flex items-center gap-2 text-xs text-muted-foreground"><ShieldCheck className="h-4 w-4 text-success" aria-hidden />{t("dashboardCheck.clean")}</p>;
  }
  return (
    <ul className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/30 px-3 py-2">
      {findings.map((f, i) => (
        <li key={i} className="flex items-start gap-2 text-xs">
          <ShieldAlert className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${f.kind === "failed" || f.kind === "missing" ? "text-destructive" : "text-warning"}`} aria-hidden />
          <span>{line(f)}</span>
        </li>
      ))}
    </ul>
  );
}
