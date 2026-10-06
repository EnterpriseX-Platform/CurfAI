/**
 * docs/REPORT_QUALITY_RULES.md, rendered from REPORT_RULES
 * (src/lib/intelligence/reportRules.ts) — the same list the models are
 * given and the gate enforces, so the document can't say something the
 * code doesn't do. `npm run report-rules:doc` writes it; a test fails when
 * the committed file is stale.
 */
import { REPORT_RULES } from "../../src/lib/intelligence/reportRules";

const WHO: Record<string, string> = {
  code: "Code",
  "code+ai": "Code, resolved by the AI review",
  ai: "AI review",
};

export function renderReportRulesDoc(): string {
  const lines = [
    "# Report quality rules",
    "",
    "<!-- Generated from src/lib/intelligence/reportRules.ts by `npm run report-rules:doc`. Edit the rules there, not here. -->",
    "",
    "Every report Curf generates — Master Builder, Instant Views, Auto-generate, a report written from a prompt, a report regenerated from comments — passes one gate before anyone sees it (`src/lib/intelligence/reportGate.ts`). The rules below are what that gate holds a report to.",
    "",
    "Each rule is told to the models that design and review a report, **and** checked in code: a prompt is advice, the check is the enforcement. Saving a generated report takes the gate's result (`persistableDefinition`), and `tests/audit/report-gate-completeness.test.ts` fails any file that generates a report and saves it another way.",
    "",
    "## How the gate runs",
    "",
    "1. Every query runs as the person the report is built for, against the real data.",
    "2. Code fixes what it can by itself — a \"Top N\" holds exactly N rows, a bar chart gets the height its bars need.",
    "3. The fast model reviews the report against these rules, each block's SQL, its rows and what code flagged. It may rename, limit or remove a block, rewrite the caption or subtitle from the results, or confirm a flag with a reason. It never writes SQL.",
    "4. The checks run again. On an AI-written report, a block whose words still don't match its query is removed and a caption with figures the results don't show is left out. A template's hand-written words are kept and flagged.",
    "5. The report is stamped with what was checked and changed; its readers see that note above the report.",
    "",
    "A report that fails (nothing left with data, or an invalid definition) is not saved.",
    "",
    "## The rules",
    "",
    "| Rule | Enforced by | What code checks | If it still fails |",
    "|---|---|---|---|",
    ...REPORT_RULES.map((r) => `| **${r.id}** ${r.title} | ${WHO[r.enforcement]} | ${r.check} | ${r.onFail} |`),
    "",
    "## What the models are told",
    "",
    ...REPORT_RULES.map((r) => `- **${r.id}** — ${r.ai}`),
    "",
    "## Changing a rule",
    "",
    "Edit `REPORT_RULES` and, when the rule is checked in code, `detectViolations` in the same file; add a case to `reportRules.test.ts`; then run `npm run report-rules:doc` and commit this file with the change.",
    "",
  ];
  return lines.join("\n");
}
