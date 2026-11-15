"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { LayoutGrid, Table2 } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";
import { cn } from "@/lib/utils";
import { ListViewControls, useListPrefs } from "@/components/lists/ListViewControls";
import { ReportCard, type ReportCardData } from "./ReportCard";

const SORTS = ["updated", "name", "owner"] as const;
type Sort = (typeof SORTS)[number];

function sorted(items: ReportCardData[], sort: Sort): ReportCardData[] {
  const byName = (a: ReportCardData, b: ReportCardData) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  const xs = [...items];
  if (sort === "name") return xs.sort(byName);
  if (sort === "owner") return xs.sort((a, b) => a.ownerName.localeCompare(b.ownerName, undefined, { sensitivity: "base" }) || byName(a, b));
  return xs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * The catalog body: the toolbar the page hands in (search, type, category)
 * with the view and sort controls beside it, then the items as cards or as a
 * dense table. Filtering stays on the server; ordering and view are the
 * reader's own and are remembered in the browser.
 */
export function ReportsCatalogView({
  items, isAdmin, toolbar, empty,
}: {
  items: ReportCardData[];
  isAdmin: boolean;
  toolbar: ReactNode;
  /** Shown instead of the items when there are none. */
  empty: ReactNode;
}) {
  const { t } = useT();
  const prefs = useListPrefs<Sort>("curf.reports.listPrefs", SORTS, "updated");
  const rows = sorted(items, prefs.sort);

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        {toolbar}
        {items.length > 0 && (
          <div className="ml-auto">
            <ListViewControls
              view={prefs.view} onView={prefs.setView}
              sort={prefs.sort} onSort={prefs.setSort}
              sorts={[
                { value: "updated", label: t("lists.sort.updated") },
                { value: "name", label: t("lists.sort.name") },
                { value: "owner", label: t("lists.sort.owner") },
              ]}
            />
          </div>
        )}
      </div>

      {items.length === 0 ? empty : prefs.view === "cards" ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(272px,1fr))] gap-4">
          {rows.map((r) => <ReportCard key={`${r.kind}:${r.id}`} isAdmin={isAdmin} r={r} />)}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t("lists.col.name")}</th>
                <th className="px-3 py-2 font-medium">{t("lists.col.type")}</th>
                <th className="px-3 py-2 font-medium">{t("lists.col.status")}</th>
                <th className="px-3 py-2 font-medium">{t("lists.col.owner")}</th>
                <th className="px-3 py-2 font-medium">{t("lists.col.updated")}</th>
                <th className="px-4 py-2 text-right font-medium">{t("lists.col.blocks")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const TypeIcon = r.kind === "dashboard" ? LayoutGrid : Table2;
                return (
                  <tr key={`${r.kind}:${r.id}`} className="border-t border-border hover:bg-muted/50">
                    <td className="max-w-[360px] px-4 py-2">
                      <Link href={r.href} className="block truncate font-medium hover:underline" title={r.name}>{r.name}</Link>
                      {r.category && <span className="block truncate text-xs text-faint">{r.category}</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5"><TypeIcon className="h-3.5 w-3.5" />{r.kind === "dashboard" ? r.labels.dashboard : r.labels.report}</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {r.published != null ? (
                        <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-2xs font-medium", r.published ? "bg-success/10 text-success" : "bg-muted text-muted-foreground")}>
                          {r.published ? r.labels.published : r.labels.draft}
                        </span>
                      ) : <span className="text-faint">—</span>}
                    </td>
                    <td className="max-w-[200px] truncate px-3 py-2 text-muted-foreground" title={r.ownerName}>{r.ownerName}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{r.updatedAgo}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-faint">{r.blocks}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
