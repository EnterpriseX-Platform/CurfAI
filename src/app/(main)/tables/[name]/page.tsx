/**
 * /tables/[name] — single-table detail.
 *
 * Shows: schema (column / type / sample), sample preview rows, source
 * metadata (where the data came from), a "Use in a report" CTA that
 * deep-links into the report designer with this table pre-selected,
 * and a danger-zone delete.
 */
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/layout/PageHeader";
import { previewRows, getTable } from "@/lib/lake/tables";
import { Database, Globe, Webhook, FileSpreadsheet, ArrowRight, Sparkles } from "lucide-react";
import { DeleteTableButton } from "./DeleteTableButton";
import { AutoGenerateButton } from "./AutoGenerateButton";
import { TableManagePanel } from "./TableManagePanel";
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

  const meta = getTable(user.tenantId, row.name);
  const preview = previewRows(user.tenantId, row.name, 50);
  const Icon = (SOURCE_ICONS as any)[row.sourceKind] ?? Database;
  const sourceConfig = safeParse(row.sourceConfigJson) ?? {};
  const schema = meta?.columns ?? safeParse(row.schemaJson) ?? [];
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

  return (
    <AppShell breadcrumbs={[{ label: t(locale, "nav.tables"), href: "/tables" }, { label: row.name }]}>
      <div className="mx-auto max-w-6xl px-8 pb-12 pt-7">
        <PageHeader
          // The source kind is information, so it stays — as the eyebrow,
          // not a roundel beside the title.
          eyebrow={<span className="inline-flex items-center gap-1.5"><Icon className="h-3.5 w-3.5" />{prettyKind(row.sourceKind, locale)}</span>}
          title={row.name}
          description={<>
            {sourceConfig.filename && <>{t(locale, "tableDetail.from")} {String(sourceConfig.filename)} · </>}
            {sourceConfig.label && <>{t(locale, "tableDetail.tokenWord")} "{String(sourceConfig.label)}" · </>}
            {t(locale, "tableDetail.rowsColsSummary").replace("{rows}", row.rowCount.toLocaleString()).replace("{cols}", String(schema.length))}
          </>}
          actions={<>
            {/* Auto-generate is the headline path: ask Claude to design a
                full dashboard (KPIs + charts + table + caption) from this
                table in one click. "Use in a report" is the manual
                fallback for users who want a blank canvas. */}
            <AutoGenerateButton tableName={row.name} />
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
            />
            <DeleteTableButton name={row.name} />
          </>}
        />

        {/* TableManagePanel's trigger lives in the header actions above; the
            expanded panel portals in here, so it lays out as a page section
            instead of a card wedged into the header's flex row. */}
        <div id="table-manage-slot" />

        <section className="mb-6 rounded-lg border border-border bg-card p-5 shadow-xs">
          <h2 className="mb-3 text-sm font-semibold">{t(locale, "tableDetail.schemaHeading")}</h2>
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
                    <td className="py-1.5 font-mono">{c.name}</td>
                    <td className="py-1.5 text-muted-foreground">{c.type}</td>
                    <td className="py-1.5 truncate font-mono text-[11px] text-muted-foreground">
                      {c.sample == null ? <span className="italic">{t(locale, "tableDetail.nullLabel")}</span> : String(c.sample).slice(0, 60)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

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
                      <th key={c.name} className="px-3 py-2 text-left font-medium">{c.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.map((r, i) => (
                    <tr key={i} className="border-t border-border">
                      {schema.map((c: any) => (
                        <td key={c.name} className="px-3 py-1.5 align-top font-mono text-[11px]">
                          {fmtCell((r as any)[c.name])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}

function safeParse(s: string | null | undefined): any {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function prettyKind(k: string, locale: Locale): string {
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
