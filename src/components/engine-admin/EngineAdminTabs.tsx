"use client";

import { useCallback, useRef, useState } from "react";
import { useT } from "@/lib/i18n/LocaleContext";
import { cn } from "@/lib/utils";
import { DatabasesPanel } from "./DatabasesPanel";
import { PeoplePanel } from "./PeoplePanel";
import { StatusPanel } from "./StatusPanel";
import { ViewsPanel } from "./ViewsPanel";
import { ENGINE_ADMIN_TABS, isEngineAdminTab, type EngineAdminPanelProps, type EngineAdminTab } from "./types";

/**
 * The engine admin console: one place, in Curf, for everything an admin does to an engine. The tab is kept in the
 * address (?tab=) so a link opens the right section and the back button works. Arrow keys move between tabs.
 */
export function EngineAdminTabs({ dataSourceId, name, initialTab }: EngineAdminPanelProps & { initialTab?: string }) {
  const { t } = useT();
  const [tab, setTab] = useState<EngineAdminTab>(isEngineAdminTab(initialTab) ? initialTab : "status");
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const select = useCallback((next: EngineAdminTab, focus = false) => {
    setTab(next);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", next);
      window.history.replaceState(null, "", url);
    } catch { /* the tab still changes; only the address is not updated */ }
    if (focus) refs.current[next]?.focus();
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const at = ENGINE_ADMIN_TABS.indexOf(tab);
    const move = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (event.key === "Home") { event.preventDefault(); select(ENGINE_ADMIN_TABS[0], true); return; }
    if (event.key === "End") { event.preventDefault(); select(ENGINE_ADMIN_TABS[ENGINE_ADMIN_TABS.length - 1], true); return; }
    if (move === 0) return;
    event.preventDefault();
    select(ENGINE_ADMIN_TABS[(at + move + ENGINE_ADMIN_TABS.length) % ENGINE_ADMIN_TABS.length], true);
  };

  const props = { dataSourceId, name };
  return (
    <div>
      <div role="tablist" aria-label={t("engineAdmin.tabs.label")} onKeyDown={onKeyDown} className="mb-6 flex gap-1 border-b border-border">
        {ENGINE_ADMIN_TABS.map((id) => {
          const active = id === tab;
          return (
            <button
              key={id}
              ref={(el) => { refs.current[id] = el; }}
              role="tab"
              type="button"
              id={`engine-tab-${id}`}
              aria-selected={active}
              aria-controls={`engine-panel-${id}`}
              tabIndex={active ? 0 : -1}
              onClick={() => select(id)}
              className={cn(
                "-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`engineAdmin.tab.${id}`)}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`engine-panel-${tab}`} aria-labelledby={`engine-tab-${tab}`} tabIndex={0} className="focus-visible:outline-none">
        {tab === "status" && <StatusPanel {...props} />}
        {tab === "people" && <PeoplePanel {...props} />}
        {tab === "views" && <ViewsPanel {...props} />}
        {tab === "databases" && <DatabasesPanel {...props} />}
      </div>
    </div>
  );
}
