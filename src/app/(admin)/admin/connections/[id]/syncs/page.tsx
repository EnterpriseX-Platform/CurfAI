/**
 * /admin/connections/[id]/syncs — per-connection sync status.
 *
 * Shows every SyncJob configured on this connection, with one row per
 * (job, source-object) pair. Each row carries last-run status, next-run
 * ETA, cursor position, and inline Run-now / Pause / View-log controls.
 *
 * The interactive bits (buttons, log expander) live in SyncsManager —
 * this page is a thin server shell that hydrates the initial data and
 * does the tenant ACL check.
 */
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AppShell } from "@/components/layout/AppShell";
import { SyncsManager } from "./SyncsManager";
import { LineConnectionManager } from "./LineConnectionManager";

export const dynamic = "force-dynamic";

export default async function ConnectionSyncsPage({ params }: { params: { id: string } }) {
  const user = await requireUser();
  if (!user) redirect(`/login?next=/admin/connections/${params.id}/syncs`);
  if (user.role !== "admin") redirect("/");

  const connection = await prisma.syncConnection.findUnique({
    where: { id: params.id },
  });
  if (!connection || connection.tenantId !== user.tenantId) {
    redirect("/admin/connections");
  }

  // D3 — LINE is push-only: no SyncJob/SyncCursor concept applies (see
  // lib/sync/connectors/line.ts's header comment), so it gets its own
  // manager with its own, much simpler server-side data load.
  if (connection.kind === "line") {
    const runs: any[] = await prisma.syncRun.findMany({
      where: { connectionId: connection.id },
      orderBy: { startedAt: "desc" },
      take: 50,
    });
    const base = (process.env.CURF_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3100").replace(/\/+$/, "");
    const initial = {
      connection: {
        id: connection.id,
        kind: connection.kind,
        name: connection.name,
        enabled: connection.enabled,
        createdAt: connection.createdAt.toISOString(),
      },
      webhookUrl: `${base}/api/line/webhook/${connection.id}`,
      runs: runs.map((r) => ({
        id: r.id,
        status: r.status,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
        rowsRead: r.rowsRead,
        rowsWritten: r.rowsWritten,
        errorMessage: r.errorMessage,
      })),
    };
    return (
      <AppShell breadcrumbs={[
        { label: "Admin" },
        { label: "Connections", href: "/admin/connections" },
        { label: connection.name },
      ]}>
        <div className="mx-auto max-w-5xl px-6 py-8">
          <LineConnectionManager initial={initial} />
        </div>
      </AppShell>
    );
  }

  const jobs: any[] = await prisma.syncJob.findMany({
    where: { connectionId: connection.id },
    orderBy: { createdAt: "asc" },
  });

  // Per-job cursor map + latest run, joined client-side once. The
  // SyncCursor + SyncRun tables are both small enough at the per-tenant
  // scale to bulk-load — < 200 cursors and < 1000 recent runs even for
  // a heavy pilot.
  const cursors: any[] = await prisma.syncCursor.findMany({
    where: { connectionId: connection.id },
  });
  const cursorMap: Record<string, any> = {};
  for (const c of cursors) cursorMap[c.objectName] = c;

  const jobIds = jobs.map((j) => j.id);
  const recentRuns: any[] = jobIds.length === 0 ? [] : await prisma.syncRun.findMany({
    where: { jobId: { in: jobIds } },
    orderBy: { startedAt: "desc" },
    take: 50,
  });
  // Latest run per jobId
  const latestRun: Record<string, any> = {};
  for (const r of recentRuns) {
    if (!latestRun[r.jobId]) latestRun[r.jobId] = r;
  }

  const initial = {
    connection: {
      id: connection.id,
      kind: connection.kind,
      name: connection.name,
      enabled: connection.enabled,
      createdAt: connection.createdAt.toISOString(),
    },
    jobs: jobs.map((j) => {
      let objects: string[] = [];
      try { objects = JSON.parse(j.objects); } catch { /* malformed — show as empty */ }
      return {
        id: j.id,
        scheduleCron: j.scheduleCron,
        objects,
        enabled: j.enabled,
        nextRunAt: j.nextRunAt.toISOString(),
        leasedBy: j.leasedBy,
        leasedUntil: j.leasedUntil ? j.leasedUntil.toISOString() : null,
        latestRun: latestRun[j.id]
          ? {
              id: latestRun[j.id].id,
              status: latestRun[j.id].status,
              startedAt: latestRun[j.id].startedAt.toISOString(),
              finishedAt: latestRun[j.id].finishedAt ? latestRun[j.id].finishedAt.toISOString() : null,
              rowsRead: latestRun[j.id].rowsRead,
              rowsWritten: latestRun[j.id].rowsWritten,
              errorMessage: latestRun[j.id].errorMessage,
            }
          : null,
      };
    }),
    cursors: cursorMap, // by objectName
  };

  return (
    <AppShell breadcrumbs={[
      { label: "Admin" },
      { label: "Connections", href: "/admin/connections" },
      { label: connection.name },
    ]}>
      <div className="mx-auto max-w-5xl px-6 py-8">
        <SyncsManager initial={initial} />
      </div>
    </AppShell>
  );
}
