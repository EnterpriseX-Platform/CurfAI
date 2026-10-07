"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Loader2, Pencil, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n/LocaleContext";
import { fill } from "@/lib/i18n/fill";
import { allAttributeNames, filterMembers, heldAttributes, memberLabel, sortMembers, type Member, type MemberSortKey, type SortDirection } from "@/lib/engine/attributeView";
import { AttributeImport } from "./AttributeImport";
import { EngineCheck } from "./EngineCheck";
import { PersonEditDialog, type SavedChange } from "./PersonEditDialog";
import { SyncNotice } from "./SyncNotice";
import { engineApi } from "./peopleApi";
import type { EngineAdminPanelProps } from "./types";

type Data = { members: Member[]; names: string[]; engines: Array<{ dataSourceId: string; name: string; source: string }> };
type Load = { phase: "loading" } | { phase: "error"; error: string } | { phase: "ready"; data: Data };

const PAGE = 100;
const CHIPS_SHOWN = 4;

function AttributeChips({ member }: { member: Member }) {
  const { t } = useT();
  const names = heldAttributes(member);
  if (names.length === 0) {
    return <span className="text-sm text-muted-foreground" title={t("engineAdmin.people.noneHint")}>{t("engineAdmin.people.none")}</span>;
  }
  return (
    <ul className="space-y-1">
      {names.map((name) => {
        const values = member.attributes[name];
        const shown = values.slice(0, CHIPS_SHOWN);
        return (
          <li key={name} className="flex flex-wrap items-center gap-1">
            <span className="font-mono text-xs text-muted-foreground">{name}</span>
            {shown.map((v) => <span key={v} className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{v}</span>)}
            {values.length > shown.length && (
              <span className="text-xs text-muted-foreground" title={values.join(", ")}>{fill(t("engineAdmin.people.moreValues"), { count: values.length - shown.length })}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function PeoplePanel(_props: EngineAdminPanelProps) {
  const { t } = useT();
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: MemberSortKey; direction: SortDirection }>({ key: "name", direction: "asc" });
  const [visible, setVisible] = useState(PAGE);
  const [editing, setEditing] = useState<Member | null>(null);
  const [notice, setNotice] = useState<{ who: string; change: SavedChange } | null>(null);

  const reload = useCallback(async (quiet = false) => {
    if (!quiet) setLoad({ phase: "loading" });
    const res = await engineApi<Data>("GET", "/api/engine/attributes");
    if (res.ok) setLoad({ phase: "ready", data: { members: res.data.members ?? [], names: res.data.names ?? [], engines: res.data.engines ?? [] } });
    else setLoad((prev) => (quiet && prev.phase === "ready" ? prev : { phase: "error", error: res.error }));
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const members = useMemo(() => (load.phase === "ready" ? load.data.members : []), [load]);
  const rows = useMemo(() => sortMembers(filterMembers(members, search), sort.key, sort.direction), [members, search, sort]);
  const known = useMemo(() => allAttributeNames(load.phase === "ready" ? load.data.names : [], members), [load, members]);

  const toggleSort = (key: MemberSortKey) => {
    setSort((s) => (s.key === key ? { key, direction: s.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" }));
    setVisible(PAGE);
  };

  const onSaved = (change: SavedChange, updated: Member) => {
    setEditing(null);
    setNotice({ who: memberLabel(updated), change });
    setLoad((prev) => (prev.phase === "ready" ? { phase: "ready", data: { ...prev.data, members: prev.data.members.map((m) => (m.userId === updated.userId ? updated : m)) } } : prev));
    void reload(true);
  };

  const sortHeader = (key: MemberSortKey, label: string) => {
    const active = sort.key === key;
    const Icon = !active ? ArrowUpDown : sort.direction === "asc" ? ArrowUp : ArrowDown;
    return (
      <th scope="col" aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"} className="px-4 py-2.5 text-left font-medium">
        <button
          type="button"
          onClick={() => toggleSort(key)}
          className="inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={fill(t("engineAdmin.people.sortBy"), { column: label })}
        >
          {label}
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </th>
    );
  };

  return (
    <div className="space-y-6">
      <section aria-labelledby="people-explain-heading" className="rounded-xl border border-border bg-muted/40 p-5">
        <h2 id="people-explain-heading" className="text-base font-semibold text-foreground">{t("engineAdmin.people.explain.title")}</h2>
        <div className="mt-2 space-y-2 text-sm text-muted-foreground">
          <p>{t("engineAdmin.people.explain.what")}</p>
          <p>{t("engineAdmin.people.explain.example")}</p>
          <p className="font-medium text-foreground">{t("engineAdmin.people.explain.noValue")}</p>
          <p>{t("engineAdmin.people.explain.source")}</p>
        </div>
      </section>

      <section aria-labelledby="people-table-heading" className="rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border p-4">
          <h2 id="people-table-heading" className="text-base font-semibold text-foreground">{t("engineAdmin.people.table.title")}</h2>
          <div className="w-full max-w-xs">
            <Label htmlFor="people-search" className="sr-only">{t("engineAdmin.people.search.label")}</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                id="people-search"
                type="search"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setVisible(PAGE); }}
                placeholder={t("engineAdmin.people.search.placeholder")}
                className="pl-8"
                autoComplete="off"
              />
            </div>
          </div>
        </div>

        <div role="status" aria-live="polite" className="px-4 pt-3 empty:hidden">
          {notice && (
            <div className="rounded-md border border-border bg-muted/40 p-3">
              <p className="text-sm font-medium text-foreground">{fill(t("engineAdmin.people.result.title"), { who: notice.who, name: notice.change.name })}</p>
              <div className="mt-1"><SyncNotice sync={notice.change.sync} savedKey="engineAdmin.people.result.saved" /></div>
            </div>
          )}
        </div>

        {load.phase === "loading" && (
          <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {t("engineAdmin.people.loading")}
          </p>
        )}
        {load.phase === "error" && (
          <div role="alert" className="m-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-foreground">
            <span>{fill(t("engineAdmin.people.loadError"), { error: load.error })}</span>
            <Button type="button" size="sm" variant="outline" onClick={() => void reload()}>{t("engineAdmin.people.retry")}</Button>
          </div>
        )}
        {load.phase === "ready" && members.length === 0 && <p className="p-6 text-sm text-muted-foreground">{t("engineAdmin.people.noMembers")}</p>}
        {load.phase === "ready" && members.length > 0 && (
          <>
            <p className="px-4 py-2 text-xs text-muted-foreground">{fill(t("engineAdmin.people.count"), { shown: rows.length, total: members.length })}</p>
            {rows.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground">{t("engineAdmin.people.noMatch")}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">{t("engineAdmin.people.table.title")}</caption>
                  <thead className="bg-muted text-muted-foreground">
                    <tr>
                      {sortHeader("name", t("engineAdmin.people.col.name"))}
                      {sortHeader("email", t("engineAdmin.people.col.email"))}
                      {sortHeader("role", t("engineAdmin.people.col.role"))}
                      <th scope="col" className="px-4 py-2.5 text-left font-medium">{t("engineAdmin.people.col.attributes")}</th>
                      <th scope="col" className="w-24 px-4 py-2.5"><span className="sr-only">{t("engineAdmin.people.col.actions")}</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, visible).map((m) => (
                      <tr key={m.userId} className="border-t border-border align-top">
                        <td className="px-4 py-2.5 font-medium text-foreground">{memberLabel(m)}</td>
                        <td className="break-all px-4 py-2.5 text-muted-foreground">{m.email}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">{m.role}</td>
                        <td className="px-4 py-2.5"><AttributeChips member={m} /></td>
                        <td className="px-4 py-2 text-right">
                          <Button type="button" size="sm" variant="outline" onClick={() => setEditing(m)} aria-label={fill(t("engineAdmin.people.editFor"), { who: memberLabel(m) })}>
                            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                            {t("engineAdmin.people.edit")}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {rows.length > visible && (
              <div className="border-t border-border p-3 text-center">
                <Button type="button" variant="ghost" size="sm" onClick={() => setVisible((v) => v + PAGE)}>
                  {fill(t("engineAdmin.people.showMore"), { count: rows.length - visible })}
                </Button>
              </div>
            )}
          </>
        )}
      </section>

      <AttributeImport onImported={() => void reload(true)} />
      <EngineCheck members={members} onSynced={() => void reload(true)} />

      {editing && (
        <PersonEditDialog member={editing} knownNames={known} onClose={() => setEditing(null)} onSaved={onSaved} />
      )}
    </div>
  );
}
