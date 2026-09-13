"use client";

import { HelpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useT } from "@/lib/i18n/LocaleContext";

/**
 * Each item's label reuses the exact nav.* key the sidebar uses for that
 * feature — one source of truth, so this dialog can never drift out of
 * sync with what the sidebar actually calls something (a real bug this
 * file had before: it was missing Ask Curf, Decisions, Metrics, Release
 * log, and API Explorer entirely, and re-typed every other label by hand
 * instead of reusing nav.*). Only the longer explanatory sentence is
 * unique to this dialog, under menuGuide.<key>.desc.
 */
const SECTIONS: { emoji: string; sectionKey: string; items: { navKey: string; descKey: string }[] }[] = [
  {
    emoji: "🛠️", sectionKey: "nav.section.workspace",
    items: [
      { navKey: "nav.masterBuilder", descKey: "menuGuide.masterBuilder.desc" },
      { navKey: "nav.brief", descKey: "menuGuide.brief.desc" },
      { navKey: "nav.askCurf", descKey: "menuGuide.askCurf.desc" },
      { navKey: "nav.reports", descKey: "menuGuide.reports.desc" },
      { navKey: "nav.onScreen", descKey: "menuGuide.onScreen.desc" },
      { navKey: "nav.dashboards", descKey: "menuGuide.dashboards.desc" },
      { navKey: "nav.notebooks", descKey: "menuGuide.notebooks.desc" },
    ],
  },
  {
    emoji: "🚀", sectionKey: "nav.section.operate",
    items: [
      { navKey: "nav.inbox", descKey: "menuGuide.inbox.desc" },
      { navKey: "nav.operateTemplates", descKey: "menuGuide.operateTemplates.desc" },
      { navKey: "nav.insights", descKey: "menuGuide.insights.desc" },
      { navKey: "nav.actionCenter", descKey: "menuGuide.actionCenter.desc" },
      { navKey: "nav.watchers", descKey: "menuGuide.watchers.desc" },
      { navKey: "nav.decisions", descKey: "menuGuide.decisions.desc" },
    ],
  },
  {
    emoji: "🗄️", sectionKey: "nav.section.data",
    items: [
      { navKey: "nav.tables", descKey: "menuGuide.tables.desc" },
      { navKey: "nav.catalog", descKey: "menuGuide.catalog.desc" },
      { navKey: "nav.metrics", descKey: "menuGuide.metrics.desc" },
      { navKey: "nav.connections", descKey: "menuGuide.connections.desc" },
      { navKey: "nav.agent", descKey: "menuGuide.agent.desc" },
      { navKey: "nav.dataQuality", descKey: "menuGuide.dataQuality.desc" },
    ],
  },
  {
    emoji: "🔍", sectionKey: "nav.section.discover",
    items: [
      { navKey: "nav.marketplace", descKey: "menuGuide.marketplace.desc" },
      { navKey: "nav.blockLibrary", descKey: "menuGuide.blockLibrary.desc" },
    ],
  },
  {
    emoji: "⚙️", sectionKey: "nav.section.admin",
    items: [
      { navKey: "nav.tenant", descKey: "menuGuide.tenant.desc" },
      { navKey: "nav.usersRoles", descKey: "menuGuide.usersRoles.desc" },
      { navKey: "nav.access", descKey: "menuGuide.access.desc" },
      { navKey: "nav.billing", descKey: "menuGuide.billing.desc" },
      { navKey: "nav.integrations", descKey: "menuGuide.integrations.desc" },
      { navKey: "nav.modernStack", descKey: "menuGuide.modernStack.desc" },
      { navKey: "nav.observability", descKey: "menuGuide.observability.desc" },
      { navKey: "nav.workspaceSetup", descKey: "menuGuide.workspaceSetup.desc" },
      { navKey: "nav.compliance", descKey: "menuGuide.compliance.desc" },
      { navKey: "nav.releaseLog", descKey: "menuGuide.releaseLog.desc" },
      { navKey: "nav.apiExplorer", descKey: "menuGuide.apiExplorer.desc" },
    ],
  },
];

export function MenuHelpDialog() {
  const { t } = useT();

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-muted-foreground hover:bg-muted hover:text-foreground">
          <HelpCircle className="h-4 w-4" />
          {/* 2xl, not sm: on a report the bar already carries eight other
              controls, so this label has to give way until there is real room. */}
          <span className="hidden 2xl:inline">{t("menuGuide.buttonLabel")}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 py-4 border-b">
          <DialogTitle>{t("menuGuide.dialogTitle")}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto px-6 py-6 text-sm text-foreground/90 space-y-6">
          {SECTIONS.map((section) => (
            <section key={section.sectionKey}>
              <h3 className="font-semibold text-lg text-primary flex items-center gap-2 mb-2">
                {section.emoji} {t(section.sectionKey).toUpperCase()}
              </h3>
              <ul className="space-y-2 list-disc list-inside">
                {section.items.map((item) => (
                  <li key={item.navKey}>
                    <strong className="text-foreground">{t(item.navKey)}:</strong> {t(item.descKey)}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
