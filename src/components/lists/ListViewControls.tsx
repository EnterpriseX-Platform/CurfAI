"use client";
/**
 * Card/list toggle and sort picker shared by the catalog-style lists
 * (/reports, /tables). The choice is a per-viewer convenience, so it lives in
 * localStorage — every read and write guarded, since storage can be blocked
 * or throw — and the page renders its defaults until it has been read.
 */
import { useEffect, useState } from "react";
import { LayoutGrid, List, ArrowDownUp } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/lib/i18n/LocaleContext";
import { cn } from "@/lib/utils";

export type ListView = "cards" | "list";

/** The view and sort a list was last shown in, remembered per list under `storageKey`. */
export function useListPrefs<S extends string>(storageKey: string, sorts: readonly S[], defaultSort: S) {
  const [view, setView] = useState<ListView>("cards");
  const [sort, setSort] = useState<S>(defaultSort);

  // Read after mount: the server render has no storage, and the first client
  // paint must match it.
  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
      if (saved?.view === "cards" || saved?.view === "list") setView(saved.view);
      if (sorts.includes(saved?.sort)) setSort(saved.sort);
    } catch { /* storage blocked or unreadable: keep the defaults */ }
    // sorts is a constant list per caller; reading once is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  function remember(next: { view: ListView; sort: S }) {
    try { window.localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* not remembered, still applied */ }
  }

  return {
    view, sort,
    setView: (v: ListView) => { setView(v); remember({ view: v, sort }); },
    setSort: (s: S) => { setSort(s); remember({ view, sort: s }); },
  };
}

export function ListViewControls<S extends string>({
  view, onView, sort, onSort, sorts,
}: {
  view: ListView;
  onView: (v: ListView) => void;
  sort: S;
  onSort: (s: S) => void;
  /** Each sort's key and its already-translated label. */
  sorts: ReadonlyArray<{ value: S; label: string }>;
}) {
  const { t } = useT();
  return (
    <div className="flex items-center gap-2">
      <Select value={sort} onValueChange={(v) => onSort(v as S)}>
        <SelectTrigger className="h-8 w-auto gap-2 text-[13px]" aria-label={t("lists.sort.label")}>
          <ArrowDownUp className="h-3.5 w-3.5 text-muted-foreground" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {sorts.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
        </SelectContent>
      </Select>
      <div role="group" aria-label={t("lists.view.label")} className="inline-flex rounded-lg border border-border bg-card p-0.5">
        <ViewButton active={view === "cards"} onClick={() => onView("cards")} label={t("lists.view.cards")}><LayoutGrid className="h-3.5 w-3.5" /></ViewButton>
        <ViewButton active={view === "list"} onClick={() => onView("list")} label={t("lists.view.list")}><List className="h-3.5 w-3.5" /></ViewButton>
      </div>
    </div>
  );
}

function ViewButton({ active, onClick, label, children }: { active: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={cn("inline-flex h-7 w-8 items-center justify-center rounded-md transition-colors",
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}
    >
      {children}
    </button>
  );
}
