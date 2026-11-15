/**
 * The report check inside the designer: the same rules the pre-publish gate runs (lib/intelligence/reportRules.ts), run on
 * the page as it stands, with the repair the gate would apply as a button. Pure, so the panel and the tests share it.
 * A fix returns the report (and the rows the query now gives) as a whole; the panel sets it in the store in one step,
 * which is what makes it one Undo.
 */
import type { Report } from "@/lib/reporting/schema";
import {
  applyRuleFix, applyScriptFix, blockTitle, detectViolations, resizeBlock, withLimit,
  type Dataset, type NumberRuleFix, type Violation,
} from "@/lib/intelligence/reportRules";

export type CheckItem = { rule: Violation["rule"]; blockId: string; title: string; detail: string; fixable: boolean; violation: Violation };

const findBlock = (report: Report, id: string) => report.pages.flatMap((p) => p.blocks).find((b) => b.id === id) ?? null;

/** What the gate's rules say about the page now, one item per block and rule. Caption and subtitle findings are the report's own. */
export function checkReport(report: Report, dataset: Dataset): CheckItem[] {
  return detectViolations(report, dataset).map((v) => {
    const block = findBlock(report, v.target);
    return { rule: v.rule, blockId: v.target, title: block ? blockTitle(block) : "", detail: v.detail, fixable: !!block && !!v.fix, violation: v };
  });
}

const RERUN = new Set<string>(["order", "weighted-ratio", "year-literal"]);

/** The repair for one finding, or null when it has none (or no longer applies). A query a fix limited gives that many rows now. */
export function applyCheckFix(report: Report, dataset: Dataset, v: Violation): { report: Report; dataset: Dataset; title: string; rerun: boolean } | null {
  const fix = v.fix;
  const block = findBlock(report, v.target);
  if (!fix || !block) return null;
  const title = blockTitle(block);
  if (fix.kind === "height") return { report: resizeBlock(report, block.id, fix.h), dataset, title, rerun: false };
  if (fix.kind === "limit") {
    const next = structuredClone(report);
    const ds = next.dataSources.find((d) => d.id === fix.queryId);
    if (!ds?.sql) return null;
    ds.sql = withLimit(ds.sql, fix.n);
    return { report: next, dataset: { ...dataset, [fix.queryId]: (dataset[fix.queryId] ?? []).slice(0, fix.n) }, title, rerun: false };
  }
  if (fix.kind === "script") {
    const done = applyScriptFix(report, fix);
    return done ? { report: done.report, dataset, title: done.title, rerun: false } : null;
  }
  const next = structuredClone(report);
  const nextDataset = structuredClone(dataset);
  const done = applyRuleFix(next, fix as NumberRuleFix, nextDataset);
  // These change a query's SQL: the rows on screen are the old ones until the next Run.
  return done ? { report: next, dataset: nextDataset, title: done.title, rerun: RERUN.has(fix.kind) } : null;
}
