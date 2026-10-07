/**
 * The guard behind every repair: a repair that takes content away is undone.
 *
 * What a report holds (verify/contentProfile.ts: block and chart kinds, maps,
 * every KPI with its plan and drill-down, tables) is measured before a repair
 * and after it. Deterministic repairs (repair.ts) settle the result before they
 * save. A report Master Builder regenerated (a new row under the same name, the
 * old one deleted) is compared here against the snapshot taken before the
 * iterate step: what it dropped is put back on it (the lost blocks with their
 * queries, a lost plan on the KPI that replaced it), and when that cannot make
 * it whole again the old definition is restored. Every outcome is a line of the
 * summary and, when something would have been lost, a finding.
 *
 *   const snap = await snapshotApp(tenantId, appSlug);          // before iterate
 *   const lines = preserveLines(snap, "Report name");           // into the repair brief
 *   ... iterate + apply ...
 *   const g = await guardApp({ tenantId, userId, appSlug, before: snap });
 */
import { prisma } from "../../src/lib/db";
import { persistAudit } from "../../src/lib/audit";
import { memberViewer } from "../../src/lib/reporting/exportCaller";
import { ReportSchema, type Report } from "../../src/lib/reporting/schema";
import { gateGeneratedReport, persistableDefinition } from "../../src/lib/intelligence/reportGate";
import { parseAppViews } from "../../src/lib/apps/schema";
import { contentLosses, contentProfile, preserveChecklist, settleContent, type ContentLoss, type ContentProfile } from "../../src/lib/master-builder/verify/contentProfile";
import type { Finding } from "../../src/lib/master-builder/verify/types";

export type ReportSnapshot = { viewId: string; reportId: string; name: string; definition: string; report: Report; profile: ContentProfile };
/** The app's reports as they were, by the tab that shows them (a regenerated report keeps its tab, not its id and not always its name). */
export type AppSnapshot = Map<string, ReportSnapshot>;

export async function snapshotApp(tenantId: string, appSlug: string): Promise<AppSnapshot> {
  const out: AppSnapshot = new Map();
  const app: any = await (prisma as any).app.findFirst({ where: { tenantId, slug: appSlug }, select: { viewsJson: true } });
  if (!app) return out;
  const views = parseAppViews(app.viewsJson).filter((v) => v.reportId);
  const rows = await prisma.report.findMany({ where: { tenantId, id: { in: views.map((v) => v.reportId!) } }, select: { id: true, name: true, definition: true } });
  for (const v of views) {
    const r = rows.find((x) => x.id === v.reportId);
    const parsed = r ? ReportSchema.safeParse(JSON.parse(r.definition)) : null;
    if (r && parsed?.success) out.set(v.id, { viewId: v.id, reportId: r.id, name: r.name, definition: r.definition, report: parsed.data, profile: contentProfile(parsed.data) });
  }
  return out;
}

/** What a regenerated report must still hold, for the repair brief: one line each. */
export function preserveLines(snapshot: AppSnapshot, reportName: string): string[] {
  const s = [...snapshot.values()].find((x) => x.name === reportName) ?? [...snapshot.values()].find((x) => x.name.toLowerCase() === reportName.toLowerCase());
  return s ? preserveChecklist(s.report) : [];
}

export type GuardOutcome = {
  name: string;
  /** ok: nothing lost; grafted: what was lost is back on the new report; reverted: the old definition is restored. */
  action: "ok" | "grafted" | "reverted";
  losses: string[];
  restored: string[];
  saved: boolean;
  note?: string;
};

const lossText = (losses: ContentLoss[]) => losses.map((l) => l.detail).join("; ");

export function revertedFinding(args: { reportId?: string; name: string; tab?: string; losses: string[]; how: "reverted" | "grafted" }): Finding {
  return {
    severity: "warn", kind: "repair-reverted", reportId: args.reportId, tab: args.tab ?? args.name, locale: "en",
    detail: `repair reverted: ${args.how === "grafted" ? "the regeneration dropped" : "would have lost"} ${args.losses.join("; ")}`,
    suggestedFix: { action: "none", autofix: false, text: "keep every chart kind, map, KPI and plan the report had; change only what the findings name" },
  };
}

/**
 * Compare each current report of the app with its snapshot. A report that
 * lost content is repaired in place: grafted (the new row keeps its id and its
 * other fixes) or, failing that, restored from the snapshot.
 */
export async function guardApp(args: {
  tenantId: string; userId: string; appSlug: string; before: AppSnapshot;
  /** What the repair was asked to remove (ContentLoss.what), if anything. */
  allow?: string[];
  log?: (...a: unknown[]) => void;
}): Promise<{ outcomes: GuardOutcome[]; findings: Finding[] }> {
  const log = args.log ?? (() => {});
  const outcomes: GuardOutcome[] = [];
  const findings: Finding[] = [];
  const now = await snapshotApp(args.tenantId, args.appSlug);
  const viewer = await memberViewer(args.tenantId, args.userId);
  const tenant = await prisma.tenant.findUnique({ where: { id: args.tenantId }, select: { currency: true } });

  for (const [viewId, cur] of now) {
    const name = cur.name;
    const old = args.before.get(viewId);
    if (!old || old.definition === cur.definition) continue;
    const losses = contentLosses(old.profile, cur.profile, args.allow);
    if (losses.length === 0) { outcomes.push({ name, action: "ok", losses: [], restored: [], saved: false }); continue; }

    const settled = settleContent(old.report, cur.report, args.allow);
    let definition: string;
    let action: GuardOutcome["action"];
    let restored: string[] = [];
    if (settled.kept) {
      // The grafted report goes through the gate like every saved report.
      const gate = await gateGeneratedReport({ report: settled.report, tenantId: args.tenantId, userId: args.userId, viewer, authored: "template", existing: true, prompt: name, tenantCurrency: tenant?.currency ?? null });
      try { definition = persistableDefinition(gate); } catch { definition = old.definition; }
      action = definition === old.definition ? "reverted" : "grafted";
      restored = settled.restored;
    } else {
      definition = old.definition;
      action = "reverted";
    }
    const row = await prisma.report.findFirst({ where: { id: cur.reportId, tenantId: args.tenantId } });
    if (!row) continue;
    const version = row.version ?? 1;
    const saved = await prisma.$transaction(async (tx) => {
      const r = await tx.report.updateMany({ where: { id: row.id, tenantId: args.tenantId, version }, data: { definition, version: version + 1 } });
      if (r.count !== 1) return false;
      await tx.reportVersion.create({ data: { tenantId: args.tenantId, reportId: row.id, version, definition: row.definition, note: `Before mb-verify guard (${action}: ${lossText(losses).slice(0, 160)})`, createdById: args.userId } });
      return true;
    });
    if (saved) await persistAudit({ tenantId: args.tenantId, userId: args.userId, kind: "report.verify_guard", target: row.id, meta: { action, losses: losses.map((l) => l.detail), restored } });
    const out: GuardOutcome = { name, action, losses: losses.map((l) => l.detail), restored, saved, note: saved ? undefined : "edited while guarding; not saved" };
    outcomes.push(out);
    findings.push(revertedFinding({ reportId: cur.reportId, name, losses: out.losses, how: action === "grafted" ? "grafted" : "reverted" }));
    log(`guard ${name}: ${action} - ${lossText(losses)}${restored.length ? ` (restored ${restored.join(", ")})` : ""}`);
  }
  return { outcomes, findings };
}

/**
 * The three calls the loop around Master Builder's iterate step needs, in one place:
 *
 *   const guard = await startRepairGuard({ tenantId, userId, appSlug, log });          // before iterate
 *   const brief = buildRepairBrief(judgement, { reportNames, preserve: guard.preserve }); // what must stay
 *   ... iterateStep + applyStep ...
 *   const g = await guard.settle();   // grafts or restores what the regeneration dropped; g.findings goes in the next round's list
 */
export async function startRepairGuard(args: { tenantId: string; userId: string; appSlug: string; allow?: string[]; log?: (...a: unknown[]) => void }) {
  const before = await snapshotApp(args.tenantId, args.appSlug);
  return {
    before,
    preserve: (reportName: string) => preserveLines(before, reportName),
    settle: () => guardApp({ ...args, before }),
  };
}
