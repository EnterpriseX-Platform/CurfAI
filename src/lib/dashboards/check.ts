/**
 * What is wrong with a dashboard before anyone looks at it: the reports it shows and how the report check judged them.
 * Pure, so the manager's panel and the tests share it. A card is a whole report or one block of one, so these are findings
 * about the reports behind its cards.
 */
export type ReportHealth = { name: string; verdict: string | null; flags: number };

export type DashboardFinding =
  | { kind: "missing"; reportId: string }
  | { kind: "duplicate"; reportId: string; name: string }
  | { kind: "failed"; reportId: string; name: string }
  | { kind: "flagged"; reportId: string; name: string; n: number }
  | { kind: "crowded"; n: number };

/** The most reports a "custom" layout puts on the screen at once before the figures are too small to read across a room. */
export const CROWDED_AT = 9;

export function checkDashboard(args: {
  reportIds: string[];
  /** How many cards the dashboard shows, when more than one of them can be blocks of the same report; defaults to the reports. */
  cardCount?: number;
  /** The reports the viewer can read, by id; an id that is not here was deleted or is not theirs to see. */
  reports: Record<string, ReportHealth | undefined>;
  layout: string;
}): DashboardFinding[] {
  const out: DashboardFinding[] = [];
  const seen = new Set<string>();
  for (const id of args.reportIds) {
    const r = args.reports[id];
    if (!r) { out.push({ kind: "missing", reportId: id }); continue; }
    if (seen.has(id)) out.push({ kind: "duplicate", reportId: id, name: r.name });
    seen.add(id);
    if (r.verdict === "fail") out.push({ kind: "failed", reportId: id, name: r.name });
    else if (r.flags > 0) out.push({ kind: "flagged", reportId: id, name: r.name, n: r.flags });
  }
  if (args.layout === "custom" && (args.cardCount ?? args.reportIds.length) > CROWDED_AT) out.push({ kind: "crowded", n: args.cardCount ?? args.reportIds.length });
  return out;
}
