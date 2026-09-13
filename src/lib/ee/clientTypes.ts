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
    /** Governed metrics are offered in the KPI query picker (the /api/metrics route is paid). */
    metricsPicker?: boolean;
  };

  connectors?: {
    /** Guided REST presets shown in the connection form. */
    hubspotBaseUrl?: string;
    zendeskBaseUrl?: (subdomain: string) => string;
  };
};
