/**
 * Workspace template registry. One source of truth for which templates
 * exist + how to load them. The /admin/workspace-templates UI iterates
 * this; the apply API resolves a templateId here.
 *
 * Adding a new template:
 *   1. Build it in lib/templates/workspaces/<id>.ts exporting a function
 *      that returns a WorkspaceTemplate.
 *   2. Append a registry entry below.
 */
import { b2bSaasTemplate } from "./b2b-saas";
import type { WorkspaceTemplate } from "./b2b-saas";

export type WorkspaceTemplateMeta = {
  id: string;
  name: string;
  description: string;
  /** Short tagline shown above the description in the picker. */
  tagline: string;
  /** Bullet list of what the template creates — for the card preview. */
  highlights: string[];
  /** Estimated apply duration in seconds (cosmetic). */
  estimatedSeconds: number;
  /** Lazy loader so the heavy data generators only run when invoked. */
  load: () => WorkspaceTemplate;
};

export const WORKSPACE_TEMPLATES: WorkspaceTemplateMeta[] = [
  {
    id: "b2b-saas",
    name: "B2B SaaS",
    tagline: "Subscription business with MRR, churn, and product engagement",
    description:
      "120 users, 4 plans, 6 months of MRR snapshots, 30 days of activity events. Comes with an MRR overview report, a 'MRR drop' watcher, and a weekly-signups materialized view.",
    highlights: [
      "4 lake tables: users, subscriptions, events, mrr_snapshots",
      "1 report: MRR & growth overview (KPIs + line chart + plans table)",
      "1 watcher: MRR drop alert (5% threshold, weekday mornings)",
      "1 materialized view: weekly_signups (refreshed Mondays at 06:00)",
    ],
    estimatedSeconds: 5,
    load: b2bSaasTemplate,
  },
];

export function findTemplate(id: string): WorkspaceTemplateMeta | null {
  return WORKSPACE_TEMPLATES.find((t) => t.id === id) ?? null;
}
