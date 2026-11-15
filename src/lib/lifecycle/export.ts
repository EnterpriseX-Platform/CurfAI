/**
 * A workspace's data, handed back: one zip an admin downloads (reports, dashboards, apps, metrics, schedules, the people
 * list, the audit log, document text, and every table in the lake as CSV).
 *
 * Two uses. An admin asks for a copy at any time. And when a deletion is requested (lib/lifecycle/deletion.ts) one is made
 * automatically and kept until the purge, so asking for deletion never costs a customer their data.
 *
 * What is NEVER in it: anything that is a credential — data-source connection strings, API keys and their hashes, LLM and
 * SMTP keys, webhook signing secrets, share/embed/ingest tokens, password hashes. Configuration blobs that can carry a
 * secret (watcher and delivery settings) have those values replaced with "[redacted]". The manifest says what it did.
 *
 * The file is built in the background, streamed table by table so a large lake isn't held in memory, written under the
 * lake directory (exports/<workspace>/), and removed when it expires or when the workspace is purged. It is a copy read
 * while the workspace stays in use, not a transactional snapshot.
 */
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { prisma } from "@/lib/db";
import { withSystemDbContext } from "@/lib/dbContext";
import { queryLake } from "@/lib/lake/tables";
import { EXPORT_FORMAT, csvLine, redactSecrets, safeCell } from "./exportFormat";
import { ZipWriter, safeEntryName } from "./zip";
import { exportsDir } from "./files";
import { LifecycleError } from "./deletion";
import { optionalModel } from "./optionalModel";

export const EXPORT_TTL_DAYS = 7;
export const MAX_ROWS_PER_TABLE = 2_000_000;
export const MAX_ARCHIVE_BYTES = 3 * 1024 ** 3;
const PAGE = 2000;
const DAY_MS = 86_400_000;
const KEEP_READY = 5;

type Note = { what: string; note: string };

export async function createWorkspaceExport(args: { tenantId: string; requestedBy: string; reason: "manual" | "before_deletion"; keepUntil?: Date; now?: Date }) {
  const now = args.now ?? new Date();
  const row = await withSystemDbContext(async () => {
    const running = await prisma.workspaceExport.findFirst({ where: { tenantId: args.tenantId, status: { in: ["queued", "running"] } }, select: { id: true } });
    if (running) {
      if (args.reason === "before_deletion") return { id: running.id, existing: true as const };
      throw new LifecycleError("An export of this workspace is already being prepared.", 409);
    }
    // Keep the few most recent ready ones; older copies go, so exports don't pile up on the volume.
    const ready = await prisma.workspaceExport.findMany({ where: { tenantId: args.tenantId, status: "ready" }, orderBy: { createdAt: "desc" }, select: { id: true, filePath: true } });
    for (const old of ready.slice(KEEP_READY - 1)) {
      if (old.filePath) fs.rmSync(old.filePath, { force: true });
      await prisma.workspaceExport.update({ where: { id: old.id }, data: { status: "expired", filePath: null } });
    }
    const created = await prisma.workspaceExport.create({
      data: {
        tenantId: args.tenantId, requestedBy: args.requestedBy, reason: args.reason,
        expiresAt: args.keepUntil ?? new Date(now.getTime() + EXPORT_TTL_DAYS * DAY_MS),
      },
    });
    return { id: created.id, existing: false as const };
  });
  if (!row.existing) {
    // In the background: the caller gets the row back at once and watches its status.
    void runWorkspaceExport(row.id).catch((e) => console.error("[export] failed:", e?.message ?? e));
  }
  return { id: row.id };
}

/** Build the archive for one queued export. Safe to call twice: only the call that claims the row does the work. */
export async function runWorkspaceExport(exportId: string): Promise<void> {
  const claimed = await withSystemDbContext(() => prisma.workspaceExport.updateMany({
    where: { id: exportId, status: "queued" }, data: { status: "running" },
  }));
  if (claimed.count !== 1) return;
  const row = await withSystemDbContext(() => prisma.workspaceExport.findUnique({ where: { id: exportId } }));
  if (!row) return;

  const dir = exportsDir(row.tenantId);
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, `${exportId}.zip`);
  const partial = finalPath + ".partial";
  const zip = new ZipWriter(partial);
  try {
    const manifest = await buildArchive(row.tenantId, row.requestedBy, zip);
    await zip.addBuffer("manifest.json", JSON.stringify(manifest, null, 2));
    const done = await zip.finish();
    fs.renameSync(partial, finalPath);
    await withSystemDbContext(() => prisma.workspaceExport.update({
      where: { id: exportId },
      data: { status: "ready", filePath: finalPath, sizeBytes: Math.min(done.bytes, 2_147_483_647), fileCount: done.entries, finishedAt: new Date(), error: null },
    }));
  } catch (e: any) {
    zip.abort();
    fs.rmSync(partial, { force: true });
    await withSystemDbContext(() => prisma.workspaceExport.update({
      where: { id: exportId }, data: { status: "failed", error: String(e?.message ?? e).slice(0, 500), finishedAt: new Date() },
    })).catch(() => null);
    throw e;
  }
}

async function buildArchive(tenantId: string, requestedBy: string, zip: ZipWriter) {
  const notes: Note[] = [];
  const counts: Record<string, number> = {};
  const lake: Array<{ table: string; rows: number; truncated: boolean }> = [];
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (e: any) { notes.push({ what, note: `skipped: ${String(e?.message ?? e).slice(0, 200)}` }); }
  };

  const tenant = await withSystemDbContext(() => prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, slug: true, tier: true, region: true, timezone: true, currency: true, createdAt: true },
  }));
  if (!tenant) throw new LifecycleError("Workspace not found", 404);
  await zip.addBuffer("workspace.json", JSON.stringify(tenant, null, 2));

  await withSystemDbContext(async () => {
    await attempt("members", async () => {
      const m = await prisma.membership.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" }, select: { role: true, createdAt: true, user: { select: { email: true, name: true } } } });
      counts.members = m.length;
      await zip.addBuffer("members.csv", [csvLine(["email", "name", "role", "joined"]), ...m.map((x) => csvLine([safeCell(x.user.email), safeCell(x.user.name), x.role, x.createdAt]))].join(""));
    });

    await attempt("reports", async () => {
      const reports = await prisma.report.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, description: true, category: true, domain: true, tagsJson: true, definition: true, version: true, published: true, createdAt: true, updatedAt: true } });
      counts.reports = reports.length;
      for (const r of reports) {
        await zip.addBuffer(`reports/${slug(r.name)}-${r.id}.json`, JSON.stringify({ ...r, definition: parse(r.definition), tags: parse(r.tagsJson), tagsJson: undefined }, null, 2));
      }
    });

    await attempt("dashboards", async () => {
      const d = await prisma.dashboard.findMany({ where: { tenantId }, select: { id: true, name: true, slug: true, reportIdsJson: true, rotationSeconds: true, theme: true, layout: true, topKpisJson: true, slotLayoutJson: true, createdAt: true, updatedAt: true } });
      counts.dashboards = d.length;
      await zip.addBuffer("dashboards.json", JSON.stringify(d.map((x) => ({ ...x, reportIds: parse(x.reportIdsJson), topKpis: parse(x.topKpisJson), slotLayout: parse(x.slotLayoutJson) })), null, 2));
    });

    await attempt("apps", async () => {
      // passwordHash (the app's access password) is deliberately not selected.
      const a = await prisma.app.findMany({ where: { tenantId }, select: { id: true, slug: true, title: true, description: true, reportId: true, authMode: true, stage: true, published: true, accentColor: true, viewsJson: true, paramsJson: true, briefConfigJson: true, createdAt: true, updatedAt: true } });
      counts.apps = a.length;
      await zip.addBuffer("apps.json", JSON.stringify(a.map((x) => ({ ...x, views: parse(x.viewsJson), params: parse(x.paramsJson), briefConfig: parse(x.briefConfigJson) })), null, 2));
    });

    await attempt("schedules", async () => {
      const s = await prisma.schedule.findMany({ where: { tenantId }, select: { id: true, reportId: true, name: true, cron: true, format: true, params: true, recipients: true, kind: true, watcherConfigJson: true, deliveryConfigJson: true, enabled: true, createdAt: true } });
      counts.schedules = s.length;
      await zip.addBuffer("schedules.json", JSON.stringify(s.map((x) => ({
        ...x, params: parse(x.params), recipients: parse(x.recipients),
        watcherConfig: redactSecrets(parse(x.watcherConfigJson)), deliveryConfig: redactSecrets(parse(x.deliveryConfigJson)),
        watcherConfigJson: undefined, deliveryConfigJson: undefined,
      })), null, 2));
    });

    await attempt("data sources", async () => {
      // The connection string (`connection`) is never selected: it holds credentials.
      const d = await prisma.dataSource.findMany({ where: { tenantId }, select: { id: true, name: true, kind: true, readOnly: true, discoveredSchemaJson: true, createdAt: true } });
      counts.dataSources = d.length;
      await zip.addBuffer("data-sources.json", JSON.stringify(d.map((x) => ({ ...x, discoveredSchema: parse(x.discoveredSchemaJson), discoveredSchemaJson: undefined, connection: "[not exported: credentials]" })), null, 2));
    });

    await attempt("metrics", async () => {
      const metric = optionalModel("metric"); // governed metrics are a paid feature: no table in the Community edition
      if (!metric) return;
      const m: any[] = await metric.findMany({ where: { tenantId }, select: { id: true, slug: true, label: true, description: true, dataSourceId: true, sql: true, format: true, unit: true, status: true, version: true, metaJson: true, createdAt: true, updatedAt: true } });
      counts.metrics = m.length;
      await zip.addBuffer("metrics.json", JSON.stringify(m.map((x) => ({ ...x, meta: parse(x.metaJson), metaJson: undefined })), null, 2));
    });

    await attempt("documents", async () => {
      const document = optionalModel("document");
      const documentChunk = optionalModel("documentChunk");
      if (!document || !documentChunk) return; // the knowledge base is a paid feature
      const docs: any[] = await document.findMany({ where: { tenantId }, select: { id: true, name: true, mimeType: true, sizeBytes: true, status: true, chunkCount: true, createdAt: true } });
      counts.documents = docs.length;
      await zip.addBuffer("documents.json", JSON.stringify(docs, null, 2));
      for (const d of docs) {
        // Only the text Curf extracted is stored, not the original file (the manifest says so).
        const chunks: Array<{ content: string }> = await documentChunk.findMany({ where: { tenantId, documentId: d.id }, orderBy: { ordinal: "asc" }, select: { content: true } });
        if (chunks.length > 0) await zip.addBuffer(`documents/${slug(d.name)}-${d.id}.txt`, chunks.map((c) => c.content).join("\n\n"));
      }
    });

    await attempt("audit log", async () => {
      const rows = await prisma.auditEvent.findMany({
        where: { tenantId }, orderBy: { createdAt: "desc" }, take: 50_000,
        select: { createdAt: true, userEmail: true, kind: true, target: true, ip: true, metaJson: true },
      });
      counts.auditEvents = rows.length;
      await zip.addBuffer("audit-log.csv", [csvLine(["time", "person", "action", "target", "ip", "details"]), ...rows.map((r) => csvLine([r.createdAt, safeCell(r.userEmail), safeCell(r.kind), safeCell(r.target), safeCell(r.ip), safeCell(r.metaJson === "{}" ? "" : r.metaJson)]))].join(""));
      if (rows.length === 50_000) notes.push({ what: "audit log", note: "the newest 50,000 events only" });
    });

    // Lake tables, one CSV each, streamed.
    const tables = await prisma.lakeTable.findMany({ where: { tenantId }, orderBy: { name: "asc" }, select: { name: true, schemaJson: true, description: true } });
    counts.lakeTables = tables.length;
    await zip.addBuffer("lake/_tables.json", JSON.stringify(tables.map((t) => ({ name: t.name, description: t.description, columns: parse(t.schemaJson) })), null, 2));
    let skippedForSize = 0;
    for (const t of tables) {
      if (zipBytes(zip) > MAX_ARCHIVE_BYTES) { skippedForSize++; notes.push({ what: `lake/${t.name}`, note: "left out: the archive reached its size limit — export it from Tables" }); continue; }
      const stats = { rows: 0, truncated: false };
      await attempt(`lake/${t.name}`, async () => {
        await zip.addStream(`lake/${safeEntryName(t.name)}.csv`, Readable.from(tableCsv(tenantId, t.name, parse(t.schemaJson), stats)));
        lake.push({ table: t.name, rows: stats.rows, truncated: stats.truncated });
        if (stats.truncated) notes.push({ what: `lake/${t.name}`, note: `the first ${MAX_ROWS_PER_TABLE.toLocaleString()} rows only` });
      });
    }
    if (skippedForSize > 0) counts.lakeTablesLeftOut = skippedForSize;
  });

  await zip.addBuffer("README.txt", README);
  return {
    format: EXPORT_FORMAT,
    workspace: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    exportedAt: new Date().toISOString(),
    requestedBy,
    counts,
    lakeTables: lake,
    notes,
    notIncluded: [
      "credentials: data-source connection strings, API keys, LLM and SMTP keys, webhook signing secrets, share/embed/ingest tokens, password hashes",
      "secret values inside watcher and delivery settings (replaced with \"[redacted]\")",
      "original document files (Curf keeps only the extracted text)",
      "report run history and cached results (re-run a report to regenerate them)",
    ],
  };
}

const README = [
  "Curf workspace export",
  "=====================",
  "",
  "workspace.json     the workspace's name and settings",
  "members.csv        who belongs to it and their role",
  "reports/           one JSON file per report (the full definition)",
  "dashboards.json, apps.json, schedules.json, metrics.json, data-sources.json, documents.json",
  "documents/         the text Curf extracted from each uploaded document",
  "audit-log.csv      the workspace's audit log (newest 50,000 events)",
  "lake/              every table in the workspace's data lake as CSV (+ _tables.json with the columns)",
  "manifest.json      what is in this archive, counts, and anything that was left out and why",
  "",
  "Lake CSVs contain the values exactly as stored. Open them in a spreadsheet with care: a cell that begins with =, +, -",
  "or @ can be run as a formula. Credentials are never included. This is a copy read while the workspace stays in use,",
  "not a transactional snapshot.",
  "",
].join("\n");

function slug(s: string): string {
  return (s || "untitled").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "untitled";
}

function parse(s: string | null | undefined): unknown {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return s; }
}

/** Bytes the archive has taken so far; the writer exposes it through its offset. */
function zipBytes(z: ZipWriter): number { return z.bytesWritten; }

/** One table as CSV lines, a page at a time; stops at MAX_ROWS_PER_TABLE and says so. */
async function* tableCsv(tenantId: string, table: string, columns: unknown, stats: { rows: number; truncated: boolean }): AsyncGenerator<string> {
  const quoted = `"${table.replace(/"/g, '""')}"`;
  let header: string[] | null = null;
  for (let offset = 0; ; ) {
    const rows = await queryLake(tenantId, `SELECT * FROM ${quoted} LIMIT ${PAGE} OFFSET ${offset}`);
    if (rows.length === 0) break;
    if (!header) { header = Object.keys(rows[0]!); yield csvLine(header); }
    let page = "";
    for (const r of rows) page += csvLine(header.map((h) => r[h]));
    yield page;
    offset += rows.length;
    stats.rows += rows.length;
    if (stats.rows >= MAX_ROWS_PER_TABLE) { stats.truncated = true; break; }
    if (rows.length < PAGE) break;
  }
  if (!header) {
    // An empty table still gets its column names.
    const names = Array.isArray(columns) ? (columns as Array<{ name?: string }>).map((c) => String(c?.name ?? "")).filter(Boolean) : [];
    if (names.length) yield csvLine(names);
  }
}

// ---------------------------------------------------------------------------
// Housekeeping and access
// ---------------------------------------------------------------------------

/** Remove exports past their date, and fail ones whose builder died with the process. */
export async function sweepWorkspaceExports(now: Date = new Date()): Promise<{ expired: number; failed: number }> {
  return withSystemDbContext(async () => {
    const stale = new Date(now.getTime() - 2 * 3_600_000);
    // nosemgrep: prisma-must-include-tenant -- housekeeping over every workspace's exports (cron, system scope)
    const failed = await prisma.workspaceExport.updateMany({
      where: { status: { in: ["queued", "running"] }, createdAt: { lte: stale } },
      data: { status: "failed", error: "interrupted (the server restarted while it was being built)", finishedAt: now },
    });
    // nosemgrep: prisma-must-include-tenant -- housekeeping over every workspace's exports (cron, system scope)
    const due = await prisma.workspaceExport.findMany({
      where: { status: "ready", expiresAt: { lte: now } }, select: { id: true, filePath: true }, take: 100,
    });
    for (const e of due) {
      if (e.filePath) fs.rmSync(e.filePath, { force: true });
      await prisma.workspaceExport.update({ where: { id: e.id }, data: { status: "expired", filePath: null } });
    }
    return { expired: due.length, failed: failed.count };
  });
}

/** An export the caller may download: it belongs to a workspace they are a real admin of, and it is ready and still on disk. */
export async function findDownloadableExport(exportId: string, adminTenantIds: string[]) {
  return withSystemDbContext(async () => {
    const e = await prisma.workspaceExport.findUnique({ where: { id: exportId } });
    if (!e || !adminTenantIds.includes(e.tenantId)) return null;
    if (e.status !== "ready" || !e.filePath || !fs.existsSync(e.filePath)) return null;
    return e;
  });
}
