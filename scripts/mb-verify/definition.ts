/**
 * The no-browser half of mb-verify: loads the reports an app's tabs show, runs
 * their queries as the dev admin (what a reader's page would run), and looks at
 * the definition and the numbers (verify/definition.ts): targets with no plan,
 * unreadable fields, series that run backwards, a year in a title the SQL never
 * filters to, unrounded decimals, a translation that changed a number, one
 * measure with two values across the app.
 */
import { prisma } from "../../src/lib/db";
import { memberViewer } from "../../src/lib/reporting/exportCaller";
import { runReportWithProof } from "../../src/lib/reporting/runner";
import { ReportSchema } from "../../src/lib/reporting/schema";
import { lakeTableColumns } from "../../src/lib/intelligence/reportGate";
import type { Dataset } from "../../src/lib/intelligence/reportRules";
import type { AppView } from "../../src/lib/apps/schema";
import { definitionFindings, inconsistentMetrics, type DefinitionInput } from "../../src/lib/master-builder/verify/definition";
import type { Finding } from "../../src/lib/master-builder/verify/types";
import { candidateDenominatorsSql, ratioPartsSql } from "../../src/lib/master-builder/verify/ratioParts";

export async function definitionPass(args: {
  tenantId: string;
  views: AppView[];
  reports: Array<{ id: string; name: string; definition: string }>;
  log?: (...a: unknown[]) => void;
}): Promise<Finding[]> {
  const user = await prisma.user.findFirst({ where: { email: process.env.MB_EMAIL ?? "admin@curf.local" }, select: { id: true } });
  if (!user) throw new Error("no dev admin to run the reports as");
  const viewer = await memberViewer(args.tenantId, user.id);
  const tableColumns = await lakeTableColumns(args.tenantId);
  const inputs: DefinitionInput[] = [];
  for (const row of args.reports) {
    const parsed = ReportSchema.safeParse(JSON.parse(row.definition));
    if (!parsed.success) continue;
    const report = parsed.data;
    let dataset: Dataset = {};
    try {
      const params = Object.fromEntries((report.parameters ?? []).map((p) => [p.name, p.default ?? ""]));
      dataset = (await runReportWithProof({ report, params, tenantId: args.tenantId, viewer })).dataset as Dataset;
    } catch (e: any) { args.log?.(`${row.name}: could not run for the definition checks (${String(e?.message ?? e).slice(0, 80)})`); }
    const view = args.views.find((v) => v.reportId === row.id);
    inputs.push({ reportId: row.id, tab: view?.label ?? row.name, report, dataset, tableColumns });
  }
  const findings = [...inputs.flatMap((i) => definitionFindings(i)), ...inconsistentMetrics(inputs)];
  await explainRatios(findings, inputs, { tenantId: args.tenantId, viewer, log: args.log });
  return findings;
}

const RATIO_KINDS = new Set(["ratio-scope", "share-out-of-range", "value-out-of-range", "gap-inconsistent"]);
const fmtNum = (n: unknown) => { const v = Number(n); return Number.isFinite(v) ? (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : String(Number(v.toPrecision(4)))) : "n/a"; };

/**
 * A percent that looks wrong is easier to repair when its two halves are
 * written next to it: the numerator and the denominator of its query are run
 * as the reader and added to the finding ("98.5% = 5,310,000,000 / 5,390,000,000").
 * A KPI that shows an amount as a percent divides nothing: the money columns of
 * its table are tried as the denominator and the plausible shares listed.
 * Best effort: a query that will not run leaves the finding as it was.
 */
async function explainRatios(findings: Finding[], inputs: DefinitionInput[], ctx: { tenantId: string; viewer: Awaited<ReturnType<typeof memberViewer>>; log?: (...a: unknown[]) => void }): Promise<void> {
  const diag = async (input: DefinitionInput, dataSourceId: string, sql: string) => {
    const params = Object.fromEntries((input.report.parameters ?? []).map((p) => [p.name, p.default ?? ""]));
    const narrow = { ...input.report, pages: [], dataSources: [{ id: "__diag", name: "diag", dataSourceId, sql }] };
    const { dataset } = await runReportWithProof({ report: narrow as any, params, tenantId: ctx.tenantId, viewer: ctx.viewer });
    return (dataset.__diag ?? []) as Array<Record<string, unknown>>;
  };
  for (const f of findings) {
    if (!RATIO_KINDS.has(f.kind) || !f.blockId) continue;
    const input = inputs.find((i) => i.reportId === f.reportId);
    const block = input?.report.pages.flatMap((p) => p.blocks).find((b) => b.id === f.blockId);
    const cfg: any = (block as any)?.config;
    const ds = input?.report.dataSources.find((d) => d.id === cfg?.queryId);
    const field: string | undefined = block?.type === "chart" ? cfg?.yFields?.[0] : cfg?.valueField;
    if (!input || !ds?.sql || !field) continue;
    try {
      const parts = ratioPartsSql(ds.sql, field);
      if (parts) {
        const rows = await diag(input, ds.dataSourceId, parts.sql);
        const r = rows[0];
        if (r) f.detail += `. It divides ${parts.numerator} = ${fmtNum(r.__num)} by ${parts.denominator} = ${fmtNum(r.__den)}${rows.length > 1 || /group by/i.test(ds.sql) ? " (the period with the highest ratio)" : ""}`;
        continue;
      }
      if (f.kind === "value-out-of-range" || f.kind === "share-out-of-range") {
        const cand = candidateDenominatorsSql(ds.sql, field, input.tableColumns);
        if (!cand) continue;
        const r = (await diag(input, ds.dataSourceId, cand.sql))[0];
        const n = Number(r?.n);
        const shares = cand.candidates.map((c, i) => ({ c, v: n / Number(r?.[`c${i}`]) })).filter((x) => Number.isFinite(x.v) && x.v >= 0 && x.v <= 1.5);
        f.detail += shares.length
          ? `. It divides nothing: ${cand.numerator} = ${fmtNum(n)}. A share needs a denominator, for example ${shares.map((x) => `${cand.numerator} / ${x.c} = ${Number((x.v * 100).toFixed(1))}%`).join("; ")}`
          : `. It divides nothing: ${cand.numerator} = ${fmtNum(n)}, an amount; no other money column of its table gives a share`;
      }
    } catch (e: any) { ctx.log?.(`ratio parts: ${String(e?.message ?? e).slice(0, 80)}`); }
  }
}
