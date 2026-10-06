/**
 * /tables/[name] — single-table detail.
 *
 * Shows: schema (column / type / sample — a formula column with its
 * formula), sample preview rows, source metadata (where the data came
 * from), a "Use in a report" CTA that deep-links into the report designer
 * with this table pre-selected, and a danger-zone delete. "Open as
 * spreadsheet" (?view=sheet) shows every row and column (SpreadsheetView).
 */
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/layout/PageHeader";
import { getTable, typedColumnsEnabled } from "@/lib/lake/tables";
import { canReadTable, previewRowsFor, columnsFor } from "@/lib/lake/readableRows";
import { mergeGovernanceMetadata, parseSchemaJson } from "@/lib/lake/schemaGovernance";
import { exportViewer } from "@/lib/reporting/exportCaller";
import { refineManualOrigin } from "@/lib/lake/originLabel";
import { freshnessIssueForOne } from "@/lib/lake/freshness";
import { ee } from "@/ee";
import { EDITION } from "@/lib/ee/edition";
import { Database, Globe, Webhook, FileSpreadsheet, ArrowRight, AlertTriangle, SquareFunction, Table2 } from "lucide-react";
import { DeleteTableButton } from "./DeleteTableButton";
import { AutoGenerateButton } from "./AutoGenerateButton";
import { TableManagePanel } from "./TableManagePanel";
import { SpreadsheetView } from "./SpreadsheetView";
import { AddColumnButton } from "./AddColumnButton";
import { canEditLakeColumns } from "@/lib/roles";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";

function readLocale(): Locale {
  const v = cookies().get("rd_locale")?.value;
  return (LOCALES as readonly string[]).includes(v ?? "") ? (v as Locale) : "en";
}

export const dynamic = "force-dynamic";

const SOURCE_ICONS = {
  upload:    FileSpreadsheet,
  webhook:   Webhook,
  rest_pull: Globe,
  manual:    Database,
} as const;

export default async function TableDetailPage({ params }: { params: { name: string } }) {
  const locale = readLocale();
  const user = await requireUser();
  if (!user) redirect("/login?next=/tables");

  const decoded = decodeURIComponent(params.name);
  const row = await prisma.lakeTable.findFirst({
    where: { tenantId: user.tenantId, name: decoded },
  }).catch(() => null);
  if (!row) notFound();

  // The rows and column samples as this viewer may see them, like the
  // Tables API: a table they can't read is as missing as one that isn't
  // there. An admin outside its roles still reaches the page to manage its
  // access, without its rows or samples.
  const viewer = await exportViewer(user);
  const readable = canReadTable(row, viewer);
  if (!readable && !viewer.isAdmin) notFound();

  const meta = await getTable(user.tenantId, row.name);
  const preview = (await previewRowsFor(row, viewer, 50)) ?? [];
  const Icon = (SOURCE_ICONS as any)[row.sourceKind] ?? Database;
  const sourceConfig = safeParse(row.sourceConfigJson) ?? {};
  const originDetail = refineManualOrigin(row.sourceKind, sourceConfig)?.detail;
  const freshnessIssue = await freshnessIssueForOne(user.tenantId, row.name, row.sourceKind, sourceConfig);
  // Types and samples from the lake file, sensitivity tags from the catalog
  // row (the file's column list has none), as the Tables API merges them.
  const tagged = parseSchemaJson(row.schemaJson);
  const catalog = meta?.columns ? mergeGovernanceMetadata(tagged, meta.columns) : tagged;
  const schema = readable ? columnsFor(catalog, row, viewer) : catalog.map((c: any) => ({ ...c, sample: undefined }));
  const visibleToRoles: string[] = (() => {
    try { const v = JSON.parse(row.visibleToRolesJson ?? "[]"); return Array.isArray(v) ? v : []; }
    catch { return []; }
  })();
  // Pull the tenant's role catalog so the manage panel can show the
  // available roles as chips. Not all tenants have roles set up; empty
  // list is fine (the panel will surface a "set up roles" CTA).
  const roleRows = await prisma.role.findMany({
    where: { tenantId: user.tenantId },
    select: { slug: true, label: true },
    orderBy: { slug: "asc" },
  }).catch(() => [] as any[]);
  const availableRoles = (roleRows as any[]).map((r) => ({ slug: r.slug, label: r.label }));

  // "Used in" — lineage is a paid feature (excluded from Community), so we
  // reach it through ee.lineage rather than importing lib/lineage.ts
  // directly, and skip it entirely in Community rather than claiming
  // "not used in any report yet" for a table we never actually checked.
  let usedByReports: Array<{ id: string; label: string }> = [];
  if (EDITION !== "community") {
    try {
      usedByReports = (await ee.lineage?.usedInReports(user.tenantId, row.id)) ?? [];
    } catch { /* lineage best-effort */ }
  }

  // Who may change the table's columns: the schema route's rule (lib/roles.ts).
  const canEditColumns = readable && canEditLakeColumns(user.role);
  const editorColumns = schema.map((c: any) => ({ name: c.name, type: c.type, formula: c.formula ?? null }));
  const sheetHref = `/tables/${encodeURIComponent(row.name)}?view=sheet`;

  return (
    <AppShell breadcrumbs={[{ label: t(locale, "nav.tables"), href: "/tables" }, { label: row.name }]}>
      <div className="mx-auto max-w-6xl px-8 pb-12 pt-7">
        <PageHeader
          // The source kind is information, so it stays — as the eyebrow,
          // not a roundel beside the title.
          eyebrow={<span className="inline-flex items-center gap-1.5"><Icon className="h-3.5 w-3.5" />{prettyKind(row.sourceKind, sourceConfig, locale)}</span>}
          title={row.name}
          description={<>
            {sourceConfig.filename && <>{t(locale, "tableDetail.from")} {String(sourceConfig.filename)} · </>}
            {sourceConfig.label && <>{t(locale, "tableDetail.tokenWord")} "{String(sourceConfig.label)}" · </>}
            {originDetail && <>{t(locale, "tableDetail.from")} {originDetail} · </>}
            {t(locale, "tableDetail.rowsColsSummary").replace("{rows}", row.rowCount.toLocaleString()).replace("{cols}", String(schema.length))}
          </>}
          actions={<>
            {/* Auto-generate is the headline path: ask Claude to design a
                full dashboard (KPIs + charts + table + caption) from this
                table in one click. "Use in a report" is the manual
                fallback for users who want a blank canvas. */}
            <AutoGenerateButton tableName={row.name} />
            {readable && (
              <Link
                href={sheetHref}
                scroll={false}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-accent"
              >
                <Table2 className="h-3.5 w-3.5" /> {t(locale, "tableDetail.openSpreadsheet")}
              </Link>
            )}
            <form action="/api/reports" method="POST" className="inline-flex">
              <input type="hidden" name="lakeTable" value={row.name} />
              <button
                type="submit"
                className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-card px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-accent"
                title={t(locale, "tableDetail.useInReportTitle")}
              >
                {t(locale, "tableDetail.useInReport")} <ArrowRight className="h-3 w-3" />
              </button>
            </form>
            <TableManagePanel
              tableName={row.name}
              initialSchema={schema}
              initialOwnerUserId={row.ownerUserId ?? null}
              initialVisibleToRoles={visibleToRoles}
              callerUserId={user.id}
              callerRole={user.role}
              availableRoles={availableRoles}
              typedConversionEnabled={typedColumnsEnabled()}
            />
            <DeleteTableButton name={row.name} />
          </>}
        />

        {freshnessIssue && (
          <div className="mb-6 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div>
              <p className="font-medium text-destructive">{t(locale, "tableDetail.freshnessIssueHeading")}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{freshnessIssue.error}</p>
            </div>
          </div>
        )}

        {/* TableManagePanel's trigger lives in the header actions above; the
            expanded panel portals in here, so it lays out as a page section
            instead of a card wedged into the header's flex row. */}
        <div id="table-manage-slot" />

        <section className="mb-6 rounded-lg border border-border bg-card p-5 shadow-xs">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{t(locale, "tableDetail.schemaHeading")}</h2>
            {canEditColumns && <AddColumnButton tableName={row.name} columns={editorColumns} />}
          </div>
          {schema.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t(locale, "tableDetail.noColumnsYet")}</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="pb-2 text-left font-medium">{t(locale, "tableDetail.colHeaderColumn")}</th>
                  <th className="pb-2 text-left font-medium">{t(locale, "tableDetail.colHeaderType")}</th>
                  <th className="pb-2 text-left font-medium">{t(locale, "tableDetail.colHeaderSample")}</th>
                </tr>
              </thead>
              <tbody>
                {schema.map((c: any) => (
                  <tr key={c.name} className="border-t border-border">
                    <td className="py-1.5 font-mono">
                      {c.formula ? (
                        <span className="inline-flex items-center gap-1 text-primary-ink" title={`= ${c.formula}`}>
                          <SquareFunction className="h-3.5 w-3.5 shrink-0" />{c.name}
                        </span>
                      ) : c.name}
                      {c.formula && <div className="max-w-[28rem] truncate text-[11px] text-primary-ink/80">= {c.formula}</div>}
                    </td>
                    <td className="py-1.5 text-muted-foreground">
                      {c.formula ? t(locale, "tableDetail.formulaType").replace("{type}", c.type) : c.type}
                    </td>
                    <td className="py-1.5 truncate font-mono text-[11px] text-muted-foreground">
                      {c.sample == null ? <span className="italic">{t(locale, "tableDetail.nullLabel")}</span> : String(c.sample).slice(0, 60)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {EDITION !== "community" && (
          <section className="mb-6 rounded-lg border border-border bg-card p-5 shadow-xs">
            <h2 className="mb-3 text-sm font-semibold">{t(locale, "tableDetail.usedByHeading")}</h2>
            {usedByReports.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t(locale, "tableDetail.usedByEmpty")}</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {usedByReports.map((r) => (
                  <li key={r.id}>
                    <Link
                      href={`/reports/${r.id}`}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs text-foreground/90 hover:bg-accent hover:underline"
                    >
                      {r.label}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section className="rounded-lg border border-border bg-card shadow-xs">
          <header className="border-b border-border px-5 py-3">
            <h2 className="text-sm font-semibold">{t(locale, "tableDetail.previewHeading")} <span className="text-[10px] font-normal text-muted-foreground">{t(locale, "tableDetail.previewFirstN").replace("{n}", String(preview.length))}</span></h2>
          </header>
          {preview.length === 0 ? (
            <p className="px-5 py-8 text-center text-xs text-muted-foreground">{t(locale, "tableDetail.noRowsYet")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    {schema.map((c: any) => (
                      <th key={c.name} className={`px-3 py-2 text-left font-medium ${c.formula ? "bg-primary-soft text-primary-ink" : ""}`}>{c.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.map((r, i) => (
                    <tr key={i} className="border-t border-border">
                      {schema.map((c: any) => (
                        <td key={c.name} className={`px-3 py-1.5 align-top font-mono text-[11px] ${c.formula ? "bg-primary-soft/60" : ""}`}>
                          {fmtCell((r as any)[c.name])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {readable && preview.length > 0 && (
            <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-2.5 text-xs text-muted-foreground">
              <span>
                {t(locale, "tableDetail.previewShowing")
                  .replace("{rows}", preview.length.toLocaleString())
                  .replace("{total}", row.rowCount.toLocaleString())}
              </span>
              <Link href={sheetHref} scroll={false} className="inline-flex items-center gap-1 font-medium text-primary-ink hover:underline">
                {t(locale, "tableDetail.openSpreadsheet")} <ArrowRight className="h-3 w-3" />
              </Link>
            </footer>
          )}
        </section>
      </div>
      {readable && <SpreadsheetView tableName={row.name} canEdit={canEditColumns} />}
    </AppShell>
  );
}

function safeParse(s: string | null | undefined): any {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function prettyKind(k: string, sourceConfig: Record<string, unknown>, locale: Locale): string {
  const refined = refineManualOrigin(k, sourceConfig);
  if (refined) return t(locale, refined.labelKey);
  switch (k) {
    case "upload":    return t(locale, "tables.source.upload");
    case "webhook":   return t(locale, "tableDetail.kind.webhookIngest");
    case "rest_pull": return t(locale, "tableDetail.kind.restPull");
    case "manual":    return t(locale, "tables.source.manual");
    default:          return k;
  }
}

function fmtCell(v: unknown): React.ReactNode {
  if (v == null || v === "") return <span className="italic text-muted-foreground/60">—</span>;
  const s = String(v);
  return s.length > 60 ? s.slice(0, 60) + "…" : s;
}
