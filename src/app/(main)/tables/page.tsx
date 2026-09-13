/**
 * /tables — Curf Tables browser.
 *
 * Tenant-scoped grid of every lake table the user owns + ingest tokens
 * panel + an upload box anchored at the top so first-timers can land
 * data in their first session without thinking about connections.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/layout/PageHeader";
import { getQuotaForTenant, getUsageForTenant, formatBytes } from "@/lib/lake/quota";
import { TablesManager } from "./TablesManager";
import { BackupsPanel } from "./BackupsPanel";
import { BackupDestinationsPanel } from "./BackupDestinationsPanel";
import { MaterializedViewsPanel } from "./MaterializedViewsPanel";
import { t, LOCALES, type Locale } from "@/lib/i18n/dict";
import { EDITION } from "@/lib/ee/edition";

export const dynamic = "force-dynamic";

function readLocale(): Locale {
  const v = cookies().get("rd_locale")?.value;
  return (LOCALES as readonly string[]).includes(v ?? "") ? (v as Locale) : "en";
}

export default async function TablesPage() {
  const user = await requireUser();
  if (!user) redirect("/login?next=/tables");
  const locale = readLocale();

  let initialTables: any[] = [];
  let initialTokens: any[] = [];
  let connections: Array<{ id: string; name: string; kind: string }> = [];
  let quota: any = null;
  let usage: any = null;
  try {
    initialTables = await prisma.lakeTable.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { updatedAt: "desc" },
    });
    initialTokens = await prisma.lakeIngestToken.findMany({
      where: { tenantId: user.tenantId, revokedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, label: true, tableName: true, prefix: true, lastUsedAt: true, createdAt: true },
    });
    connections = await prisma.dataSource.findMany({
      where: { tenantId: user.tenantId },
      select: { id: true, name: true, kind: true },
      orderBy: { name: "asc" },
    });
    quota = await getQuotaForTenant(user.tenantId);
    usage = await getUsageForTenant(user.tenantId);
  } catch {
    /* LakeTable / LakeIngestToken model missing until prisma db push runs. */
    quota = { tier: "community", maxBytes: 100 * 1024 * 1024, maxTables: 10 };
    usage = { bytes: 0, tables: 0 };
  }

  return (
    <AppShell breadcrumbs={[{ label: t(locale, "nav.tables") }]}>
      <div className="mx-auto max-w-6xl px-8 pb-12 pt-7">
        <PageHeader
          title={t(locale, "tables.pageTitle")}
          description={t(locale, "tables.pageSubtitle")}
          actions={
            // The quota receipt: what's used of what's allowed, in mono.
            <div className="text-right font-mono text-xs text-faint">
              <div>
                <span className="font-medium text-foreground">{formatBytes(usage.bytes)}</span> {t(locale, "tables.usageOf")} {quota.maxBytes ? formatBytes(quota.maxBytes) : t(locale, "tables.unlimited")}
              </div>
              <div>
                <span className="font-medium text-foreground">{usage.tables}</span> {usage.tables === 1 ? t(locale, "tables.tableSingular") : t(locale, "tables.tablePlural")}{quota.maxTables ? ` ${t(locale, "tables.usageOf")} ${quota.maxTables}` : ""}
              </div>
              <div className="mt-1 inline-block rounded-sm border border-border px-1.5 py-px text-[11px] uppercase tracking-[.04em]">
                {quota.tier}
              </div>
            </div>
          }
        />

        <TablesManager
          initialTables={initialTables.map((t: any) => ({
            id: t.id,
            name: t.name,
            sourceKind: t.sourceKind,
            schema: safeParse(t.schemaJson) ?? [],
            rowCount: t.rowCount,
            sizeBytes: t.sizeBytes,
            createdAt: typeof t.createdAt === "string" ? t.createdAt : t.createdAt?.toISOString?.() ?? "",
            updatedAt: typeof t.updatedAt === "string" ? t.updatedAt : t.updatedAt?.toISOString?.() ?? "",
          }))}
          initialTokens={initialTokens.map((tk: any) => ({
            id: tk.id,
            label: tk.label,
            tableName: tk.tableName,
            prefix: tk.prefix,
            lastUsedAt: tk.lastUsedAt ? (typeof tk.lastUsedAt === "string" ? tk.lastUsedAt : tk.lastUsedAt.toISOString()) : null,
            createdAt: typeof tk.createdAt === "string" ? tk.createdAt : tk.createdAt.toISOString(),
          }))}
        />

        {/* Backups + restore — production-durability scaffolding from
            Phase 2 of ROADMAP-DATA-LAYER.md. Collapsible so it doesn't
            crowd the table grid; nightly snapshots happen automatically
            via the cron tick. */}
        <div id="backups" className="mt-6 scroll-mt-20">
          <BackupsPanel canAdmin={user.role === "admin"} />
        </div>

        {/* Off-site backup destinations — push every snapshot to a
            customer-owned bucket via HTTPS PUT (S3 presigned, R2,
            Azure SAS, B2, WebDAV, etc). Sits directly under Backups
            because they are conceptually one feature ("snapshots
            land safely + are also pushed off-site"). */}
        <div className="mt-4">
          {/* Off-site backup destinations are Business — the model and API are absent in Community. */}
          {EDITION !== "community" && <BackupDestinationsPanel canAdmin={user.role === "admin"} />}
        </div>

        {/* Materialized views — pre-computed query caches refreshed on a
            cron. Phase 3 production-grade query acceleration; sits next
            to Backups so all "ops on the lake" UI is in one place. */}
        <div className="mt-4">
          <MaterializedViewsPanel connections={connections} />
        </div>
      </div>
    </AppShell>
  );
}

function safeParse(s: string | null | undefined): any {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
