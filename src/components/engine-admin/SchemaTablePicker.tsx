"use client";

import { useMemo, useState } from "react";
import { Table2 } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { fill } from "@/lib/engine/fill";
import type { Introspection } from "@/lib/engine/adminClient";
import { tableRef } from "@/lib/engine/viewForm";

const MAX_SHOWN = 200;

/** A searchable list of the tables the engine found, as `schema.table`. Used to browse and to start a view from one. */
export function SchemaTablePicker({ intro, selected, onSelect, idPrefix }: {
  intro: Introspection; selected: string | null; onSelect: (schema: string, table: string) => void; idPrefix: string;
}) {
  const { t } = useT();
  const [query, setQuery] = useState("");
  const all = useMemo(
    () => intro.schemas.flatMap((s) => s.tables.map((tb) => ({ schema: s.name, table: tb.name, ref: tableRef(s.name, tb.name), columns: tb.columns.length }))),
    [intro],
  );
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => (q ? all.filter((x) => x.ref.toLowerCase().includes(q)) : all), [all, q]);
  const shown = matches.slice(0, MAX_SHOWN);

  return (
    <div className="space-y-2">
      <label htmlFor={`${idPrefix}-search`} className="sr-only">{t("engineAdmin.databases.browse.search")}</label>
      <Input id={`${idPrefix}-search`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("engineAdmin.databases.browse.search")} />
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {fill(t("engineAdmin.databases.browse.count"), { n: matches.length })}
        {intro.truncated && ` ${t("engineAdmin.databases.browse.truncated")}`}
        {matches.length > MAX_SHOWN && ` ${fill(t("engineAdmin.databases.browse.firstShown"), { n: MAX_SHOWN })}`}
      </p>
      {shown.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">{t("engineAdmin.databases.browse.none")}</p>
      ) : (
        <ul className="max-h-72 divide-y divide-border overflow-auto rounded-md border border-border">
          {shown.map((x) => (
            <li key={x.ref}>
              <button
                type="button"
                onClick={() => onSelect(x.schema, x.table)}
                aria-pressed={selected === x.ref}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  selected === x.ref && "bg-primary-soft",
                )}
              >
                <Table2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{x.ref}</span>
                <span className="shrink-0 text-xs text-faint">{fill(t("engineAdmin.databases.browse.columns"), { n: x.columns })}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
