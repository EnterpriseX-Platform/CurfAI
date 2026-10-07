/**
 * The deterministic half of the repair loop: what code can fix without a
 * model's judgement (verify/autofix.ts), applied to the saved reports and
 * saved the way every generated report is — through the gate
 * (`persistableDefinition(await gateGeneratedReport(...))`), with the old
 * definition kept as a ReportVersion and an audit event. Tenant-scoped; the
 * save is refused when the report was edited since it was read.
 *
 * The fast model is asked for two things only, and code checks each answer:
 * the words a language is missing (translate.ts: its script, every number
 * kept) and a shorter phrase for a title code could not cut at a qualifier
 * (shortenWithModel). A title that still cannot be shortened safely is left
 * as it is and reported (`unshortenable`): a clipped title with an ellipsis
 * and a tooltip beats a broken one.
 */
import { prisma } from "../../src/lib/db";
import { persistAudit } from "../../src/lib/audit";
import { memberViewer } from "../../src/lib/reporting/exportCaller";
import { runReportWithProof } from "../../src/lib/reporting/runner";
import { ReportSchema, type Report } from "../../src/lib/reporting/schema";
import { gateGeneratedReport, persistableDefinition } from "../../src/lib/intelligence/reportGate";
import type { Dataset } from "../../src/lib/intelligence/reportRules";
import { applyProseRewrite, applyTitleText, autofixReport, type AppliedFix } from "../../src/lib/master-builder/verify/autofix";
import { needsTranslation, translationGaps, type TranslationGap } from "../../src/lib/master-builder/verify/i18nGaps";
import { applyTranslations, rewriteProseWithModel, shortenWithModel, translateGaps, type ShortenItem } from "../../src/lib/master-builder/verify/translate";
import { parseAppViews } from "../../src/lib/apps/schema";
import { contentLosses, contentProfile, settleContent } from "../../src/lib/master-builder/verify/contentProfile";
import type { Finding, Locale } from "../../src/lib/master-builder/verify/types";

export type RepairOutcome = {
  reportId: string;
  name: string;
  applied: AppliedFix[];
  translated: number;
  /** Autofixable findings the code could not clear. */
  unresolved: Finding[];
  /** Titles no clean cut or accepted rewrite fits: left as they are (the card shows an ellipsis and a tooltip). */
  unshortenable: Array<{ blockId: string; locale: Locale; text: string }>;
  saved: boolean;
  /** What the repair would have taken away (it was not saved), or put back after a regeneration: "map: 1 -> 0". */
  reverted?: string[];
  note?: string;
};

const shortenKey = (f: Finding) => `${f.blockId}|${f.locale}|${f.suggestedFix.params?.text ?? ""}`;

export async function repairDeterministic(args: {
  tenantId: string;
  userId: string;
  findings: Finding[];
  /** Ask the fast model for missing Thai/Chinese/English text and for titles code cannot cut cleanly. */
  translate: boolean;
  /** The app the findings are from: its own tab labels (Executive, What-if), which no report holds, are translated too. */
  appSlug?: string;
  log?: (...a: unknown[]) => void;
}): Promise<RepairOutcome[]> {
  const log = args.log ?? (() => {});
  // The tab labels of the app itself: no report holds them (repairAppLabels).
  if (args.translate && args.appSlug && args.findings.some((f) => f.suggestedFix.action === "add-translation" && f.suggestedFix.params?.tabLabel)) {
    const n = await repairAppLabels({ tenantId: args.tenantId, userId: args.userId, appSlug: args.appSlug, log });
    if (n) log(`app tab labels: ${n} written`);
  }
  const byReport = new Map<string, Finding[]>();
  for (const f of args.findings) if (f.reportId && f.suggestedFix.autofix) (byReport.get(f.reportId) ?? byReport.set(f.reportId, []).get(f.reportId)!).push(f);
  const tenant = await prisma.tenant.findUnique({ where: { id: args.tenantId }, select: { currency: true } });
  const viewer = await memberViewer(args.tenantId, args.userId);
  const out: RepairOutcome[] = [];

  for (const [reportId, findings] of byReport) {
    const row = await prisma.report.findFirst({ where: { id: reportId, tenantId: args.tenantId } });
    if (!row) continue;
    const base = { reportId, name: row.name, applied: [] as AppliedFix[], translated: 0, unresolved: [] as Finding[], unshortenable: [] as RepairOutcome["unshortenable"], saved: false };
    const parsed = ReportSchema.safeParse(JSON.parse(row.definition));
    if (!parsed.success) { out.push({ ...base, note: "the saved definition does not validate; left alone" }); continue; }
    const report: Report = parsed.data;

    let dataset: Dataset = {};
    try {
      const params = Object.fromEntries((report.parameters ?? []).map((p) => [p.name, p.default ?? ""]));
      dataset = (await runReportWithProof({ report, params, tenantId: args.tenantId, viewer })).dataset as Dataset;
    } catch (e: any) { log(`${row.name}: could not run to size it (${String(e?.message ?? e).slice(0, 80)})`); }

    const fixed = autofixReport(report, findings, dataset, { currency: tenant?.currency ?? undefined });
    const applied = [...fixed.applied];

    // Titles with no clean cut: a shorter phrase from the fast model, accepted only when code agrees (words, years, script, length).
    let unresolved = fixed.unresolved;
    const unshortenable: RepairOutcome["unshortenable"] = [];
    // A title still in the wrong language waits for its translation (the next round measures that), not for a shorter phrase.
    const stuck = unresolved.filter((f) => f.suggestedFix.action === "shorten-title" && typeof f.suggestedFix.params?.text === "string" && typeof f.suggestedFix.params?.max === "number" && !needsTranslation(f.suggestedFix.params.text, f.locale));
    if (stuck.length) {
      const items: ShortenItem[] = [...new Map(stuck.map((f) => [shortenKey(f), { id: shortenKey(f), text: f.suggestedFix.params!.text as string, max: f.suggestedFix.params!.max as number }])).values()];
      const answers = args.translate ? await shortenWithModel(items, { tenantId: args.tenantId, userId: args.userId }) : new Map<string, string>();
      const done = new Set<string>();
      for (const f of stuck) {
        const shorter = answers.get(shortenKey(f));
        if (shorter && applyTitleText(fixed.report, f, shorter, applied)) done.add(shortenKey(f));
        else unshortenable.push({ blockId: f.blockId ?? "", locale: f.locale, text: f.suggestedFix.params!.text as string });
      }
      unresolved = unresolved.filter((f) => !(f.suggestedFix.action === "shorten-title" && done.has(shortenKey(f))));
    }

    // Thai and Chinese captions that name a column by its key: the model writes the plain words, code checks them.
    if (args.translate && fixed.prose.length) {
      const items = fixed.prose.map((p, n) => ({ id: String(n), text: p.text }));
      const done = await rewriteProseWithModel(items, { tenantId: args.tenantId, userId: args.userId });
      for (const [id, text] of done) {
        const item = fixed.prose[Number(id)]!;
        if (applyProseRewrite(fixed.report, item, text)) applied.push({ action: "clean-prose", blockId: item.blockId, detail: `${item.locale ?? "config"}.${item.path}: column keys -> words (model)` });
      }
    }

    let translated = 0;
    if (args.translate && findings.some((f) => f.suggestedFix.action === "add-translation" || f.suggestedFix.action === "retranslate")) {
      const gaps = translationGaps(fixed.report);
      if (gaps.length) translated = applyTranslations(fixed.report, await translateGaps(gaps, { tenantId: args.tenantId, userId: args.userId }));
    }
    if (applied.length === 0 && translated === 0) { out.push({ ...base, unresolved, unshortenable, note: "nothing the code could change" }); continue; }

    // A repair that takes a map, a chart kind, a KPI or a plan away is refused: what it dropped is put back, or it is not saved.
    const settled = settleContent(report, fixed.report);
    if (!settled.kept) {
      const reverted = settled.losses.map((l) => l.detail);
      log(`${row.name}: repair reverted - would have lost ${reverted.join("; ")}`);
      out.push({ ...base, applied, translated, unresolved, unshortenable, reverted, note: `repair reverted: would have lost ${reverted.join("; ")}` });
      continue;
    }
    fixed.report = settled.report;

    const gate = await gateGeneratedReport({
      report: fixed.report, tenantId: args.tenantId, userId: args.userId, viewer, authored: "template", existing: true,
      prompt: row.name, tenantCurrency: tenant?.currency ?? null,
    });
    let definition: string;
    try { definition = persistableDefinition(gate); }
    catch (e: any) { out.push({ ...base, applied, translated, unresolved, unshortenable, note: `the gate refused the repaired report: ${e?.message}` }); continue; }

    // The gate runs after the guard: what it removed counts too.
    const afterGate = contentLosses(contentProfile(report), contentProfile(gate.report));
    if (afterGate.length) {
      const reverted = afterGate.map((l) => l.detail);
      log(`${row.name}: repair reverted - the gate would have lost ${reverted.join("; ")}`);
      out.push({ ...base, applied, translated, unresolved, unshortenable, reverted, note: `repair reverted: the gate would have lost ${reverted.join("; ")}` });
      continue;
    }

    const version = row.version ?? 1;
    const saved = await prisma.$transaction(async (tx) => {
      const r = await tx.report.updateMany({ where: { id: row.id, tenantId: args.tenantId, version }, data: { definition, version: version + 1 } });
      if (r.count !== 1) return false;
      await tx.reportVersion.create({ data: { tenantId: args.tenantId, reportId: row.id, version, definition: row.definition, note: "Before mb-verify repair", createdById: args.userId } });
      return true;
    });
    if (saved) await persistAudit({ tenantId: args.tenantId, userId: args.userId, kind: "report.verify_repair", target: row.id, meta: { applied: applied.length, translated, verdict: gate.verdict } });
    out.push({ ...base, applied, translated, unresolved, unshortenable, saved, ...(settled.restored.length ? { reverted: settled.losses.map((l) => l.detail) } : {}), note: saved ? (settled.restored.length ? `put back after the repair dropped it: ${settled.restored.join(", ")}` : undefined) : "edited while repairing; not saved" });
  }
  return out;
}

/**
 * The app's own tab labels (an app view's `label`, and its `labelI18n`): a tab
 * the report cannot translate — Executive, Ask the Data — keeps its English in
 * a Thai or Chinese page. Fills the missing languages with the same guarded
 * translation step and saves the app's views. Returns how many labels it wrote.
 */
export async function repairAppLabels(args: { tenantId: string; userId: string; appSlug: string; log?: (...a: unknown[]) => void }): Promise<number> {
  const app: any = await (prisma as any).app.findFirst({ where: { tenantId: args.tenantId, slug: args.appSlug }, select: { id: true, viewsJson: true } });
  if (!app) return 0;
  const views = parseAppViews(app.viewsJson);
  const gaps: TranslationGap[] = [];
  for (const v of views) {
    for (const locale of ["th", "zh"] as Locale[]) {
      const have = v.labelI18n?.[locale];
      if (needsTranslation(v.label, locale) && !(have && !needsTranslation(have, locale))) gaps.push({ blockId: v.id, path: "label", text: v.label, locale });
    }
  }
  if (!gaps.length) return 0;
  const done = await translateGaps(gaps, { tenantId: args.tenantId, userId: args.userId });
  if (!done.length) return 0;
  const next = views.map((v) => {
    const mine = done.filter((d) => d.blockId === v.id);
    return mine.length ? { ...v, labelI18n: { ...v.labelI18n, ...Object.fromEntries(mine.map((d) => [d.locale, d.translated.slice(0, 60)])) } } : v;
  });
  const r = await (prisma as any).app.updateMany({ where: { id: app.id, tenantId: args.tenantId }, data: { viewsJson: JSON.stringify(next) } });
  if (r.count === 1) await persistAudit({ tenantId: args.tenantId, userId: args.userId, kind: "app.verify_repair", target: app.id, meta: { labels: done.length } });
  args.log?.(`tab labels: ${done.length} translation(s) written`);
  return r.count === 1 ? done.length : 0;
}
