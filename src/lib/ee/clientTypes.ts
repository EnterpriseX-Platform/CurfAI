/**
 * The Community / paid boundary — client side. Same idea as types.ts, for
 * React components that render paid UI inside Community surfaces (the
 * Operate request dialog on a report, the watcher-suggestions banner).
 * Filled by `src/ee/client.tsx` in the private repo, stubbed in the export.
 */
import type { ComponentType } from "react";
import type { Edition } from "./types";

export type EeClientRegistry = {
  edition: Edition;

  operate?: {
    /** The dialog every "Act" affordance opens. */
    NewRequestDialog: ComponentType<any>;
    /** Does a chart-click template scope match this block / row? */
    matchesChartClickScope: (...args: any[]) => boolean;
  };

  reports?: {
    /** "Curf noticed an anomaly — add a watcher?" banner on the report viewer. */
    WatcherSuggestionsBanner?: ComponentType<any>;
    /** The Ask Curf chat panel on the report viewer (ai.talks_back). */
    AskCurfPanel?: ComponentType<{ reportId: string; currentParams: Record<string, unknown> }>;
    /** "Why?" on a KPI card — grounded explanation of what moved (ai.why_everywhere). */
    AskWhyButton?: ComponentType<any>;
    /** Overflow-menu entry: Claude proposes chart-click Operate templates for this report. */
    SuggestOperateActionsButton?: ComponentType<{ reportId: string }>;
    /** Overflow-menu entry: publish the report to the template marketplace. */
    PublishToMarketplaceButton?: ComponentType<{ reportId: string; reportName: string }>;
  };

  designer?: {
    /** Toolbar "Publish" — turns the report into an Analytic App. */
    PublishButton?: ComponentType<{ reportId: string }>;
    /** Toolbar "Suggest" — Claude proposes the next chart (ai.suggest_charts). */
    SuggestChartButton?: ComponentType<{ reportId: string }>;
    /** Toolbar "Story" — the auto-narrated walkthrough page (ai.story_mode). */
    storyMode?: boolean;
    /** Governed metrics are offered in the KPI query picker (the /api/metrics route is paid). */
    metricsPicker?: boolean;
  };

  connectors?: {
    /** Guided REST presets shown in the connection form. */
    hubspotBaseUrl?: string;
    zendeskBaseUrl?: (subdomain: string) => string;
  };

  layout?: {
    /** Slim banner between the top bar and page content when the workspace's
     *  Stripe subscription payment has failed (billing.past_due) — mounted
     *  from AppShell, which ships in Community too, so this goes through the
     *  registry like everything else here rather than a bare edition check:
     *  Community tenants never hold a Stripe subscription in the first
     *  place, and the component itself is Cloud billing UI. */
    PastDueBanner?: ComponentType<{ isAdmin: boolean }>;
  };
};
