import { PrismaClient } from "@prisma/client";
import { toDriverSql } from "./sqlPlaceholders";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// ── Raw-SQL fallback delegates ────────────────────────────────────────
// When the Prisma client hasn't been regenerated since a new model was
// added (`npx prisma db push` not yet run), the model-named delegate
// is undefined and `prisma.lakeExternalTable.findMany(...)` throws.
//
// We attach lightweight shims that go through $queryRawUnsafe so the
// app keeps working until the next regen. They cover the few methods
// we use today (findMany, findFirst, findUnique, create, delete) and
// are intentionally minimal — anything fancier should be done through
// the proper Prisma client after a regen.
//
// Guarded with `typeof window === "undefined"` so the shim never runs
// in code paths Next.js bundles for the browser — accessing prisma in
// a browser bundle throws "PrismaClient is unable to run in this
// browser environment", which would crash any page that transitively
// imports this module via a client component tree.
if (typeof window === "undefined") {
  attachRawShim("lakeExternalTable", "LakeExternalTable", [
    "id", "tenantId", "name", "format", "uri", "credentialsEnc", "schemaJson",
    "description", "domain", "tagsJson", "isCurated", "dbtMetaJson",
    "lastQueriedAt", "lastRowCountEstimate", "createdAt", "updatedAt", "createdById",
  ]);
  attachRawShim("pushSubscription", "PushSubscription", [
    "id", "tenantId", "userId", "endpoint", "p256dh", "authSecret", "label",
    "enabled", "lastPushedAt", "lastPushOk", "lastPushError", "createdAt",
  ]);
  // ── Curf Operate (declarative business-action engine) ─────────────
  // Tables auto-create on first access (see ensureOperateTables) so the
  // app boots even before `npx prisma db push` regenerates the client.
  ensureOperateTables().catch((err) => {
    console.warn("[db] ensureOperateTables failed:", err?.message ?? err);
  });
  attachRawShim("actionTemplate", "ActionTemplate", [
    "id", "tenantId", "name", "slug", "description", "triggerKind",
    "triggerConfigJson", "inputSchemaJson", "approvalChainJson",
    "destinationKind", "destinationConfigJson", "payloadTemplateJson",
    "slaMinutes", "dryRun", "enabled", "iconKind", "colorTag",
    "compensatingTemplateSlug",
    // Slack approvals — channel id (Cxxx) where this template's approval
    // cards are posted. null/empty falls back to SlackInstallation.defaultChannelId.
    "slackApprovalChannelId",
    // C4 — document generation config (null = off). See engine.ts/documentDraft.ts.
    "documentGenerationJson",
    "createdAt", "updatedAt", "createdById",
  ]);
  attachRawShim("actionRequest", "ActionRequest", [
    "id", "tenantId", "templateId", "templateName", "inputJson",
    "chainSnapshotJson", "destinationKind", "destinationConfigSnapshotJson",
    "payloadSnapshotJson", "status", "currentStep", "dryRun",
    "idempotencyKey", "contextJson", "slaMinutes", "slaBreachAt",
    "requestedById", "requestedByEmail", "reason", "errorMessage",
    "finishedAt", "createdAt", "updatedAt",
    // SLA tracking — stamped once the breach webhook + Slack DM fire,
    // so the cron tick doesn't keep re-notifying past the first breach.
    "slaBreachNotifiedAt",
    // Why-this-matters — cached LLM digest of the approval's context.
    "whyDigest",
  ]);
  attachRawShim("actionApproval", "ActionApproval", [
    "id", "tenantId", "requestId", "step", "approverKind", "approverValue",
    "decision", "decidedById", "decidedByEmail", "comment", "decidedAt", "createdAt",
    // Slack approvals — message coordinates so we can chat.update the
    // posted card when the approval is decided (live status reflection).
    "slackChannelId", "slackMessageTs",
    // SLA tracking — stepStartedAt is the breach-timer origin; reminder
    // + breached are anti-spam stamps for the cron pass.
    "stepStartedAt", "slaReminderSentAt", "breachedAt",
  ]);
  attachRawShim("actionExecution", "ActionExecution", [
    "id", "tenantId", "requestId", "attempt", "status", "destinationKind",
    "payloadJson", "responseJson", "errorMessage", "durationMs",
    "startedAt", "finishedAt",
  ]);
  // ── Master Builder ─────────────────────────────────────────────────
  // Persistent project + artifacts + chat history. Tables auto-create
  // on first access via ensureMasterBuilderTables() so dev SQLite
  // cold-starts work before `npx prisma db push` runs.
  ensureMasterBuilderTables().catch((err) => {
    console.warn("[db] ensureMasterBuilderTables failed:", err?.message ?? err);
  });
  attachRawShim("masterBuild", "MasterBuild", [
    "id", "tenantId", "prompt", "domain", "status",
    "planJson", "statusJson", "summary",
    "startedAt", "finishedAt", "lastIteratedAt",
    "createdById", "version",
  ]);
  attachRawShim("masterBuildArtifact", "MasterBuildArtifact", [
    "id", "buildId", "tenantId", "kind", "refId", "name",
    "provenance", "buildVersion", "dependsOnJson",
    "status", "errorMessage", "createdAt", "updatedAt",
  ]);
  attachRawShim("masterBuildMessage", "MasterBuildMessage", [
    "id", "buildId", "tenantId", "role", "content",
    "planJson", "planStatus", "appliedAt", "createdAt",
  ]);
}

/**
 * Idempotent bootstrap for the Master Builder tables on dev SQLite.
 * Mirrors ensureOperateTables — Postgres deployments rely on the normal
 * `prisma migrate deploy` path; this is the dev shortcut so the project
 * boots without a manual `db push` after schema changes land.
 */
async function ensureMasterBuilderTables() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("file:") && !url.endsWith(".db")) return;
  // HMR re-imports lib/db.ts on every save; gate the bootstrap so it only
  // runs once per Node process.
  const g = globalThis as any;
  if (g.__curfMasterBuilderDDLDone) return;
  g.__curfMasterBuilderDDLDone = true;
  const stmts: string[] = [
    `CREATE TABLE IF NOT EXISTS "MasterBuild" (
      "id" TEXT PRIMARY KEY,
      "tenantId" TEXT NOT NULL,
      "prompt" TEXT NOT NULL,
      "domain" TEXT,
      "status" TEXT NOT NULL DEFAULT 'draft',
      "planJson" TEXT NOT NULL DEFAULT '{}',
      "statusJson" TEXT NOT NULL DEFAULT '{}',
      "summary" TEXT,
      "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "finishedAt" DATETIME,
      "lastIteratedAt" DATETIME,
      "createdById" TEXT,
      "version" INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS "MasterBuild_tenantId_status_idx" ON "MasterBuild"("tenantId","status")`,
    `CREATE INDEX IF NOT EXISTS "MasterBuild_tenantId_startedAt_idx" ON "MasterBuild"("tenantId","startedAt")`,
    `CREATE TABLE IF NOT EXISTS "MasterBuildArtifact" (
      "id" TEXT PRIMARY KEY,
      "buildId" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "kind" TEXT NOT NULL,
      "refId" TEXT,
      "name" TEXT NOT NULL,
      "provenance" TEXT NOT NULL DEFAULT 'seeded',
      "buildVersion" INTEGER NOT NULL DEFAULT 1,
      "dependsOnJson" TEXT NOT NULL DEFAULT '[]',
      "status" TEXT NOT NULL DEFAULT 'ok',
      "errorMessage" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS "MasterBuildArtifact_buildId_kind_idx" ON "MasterBuildArtifact"("buildId","kind")`,
    `CREATE INDEX IF NOT EXISTS "MasterBuildArtifact_refId_kind_idx" ON "MasterBuildArtifact"("refId","kind")`,
    `CREATE INDEX IF NOT EXISTS "MasterBuildArtifact_tenantId_provenance_idx" ON "MasterBuildArtifact"("tenantId","provenance")`,
    `CREATE TABLE IF NOT EXISTS "MasterBuildMessage" (
      "id" TEXT PRIMARY KEY,
      "buildId" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "role" TEXT NOT NULL,
      "content" TEXT NOT NULL,
      "planJson" TEXT,
      "planStatus" TEXT,
      "appliedAt" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS "MasterBuildMessage_buildId_createdAt_idx" ON "MasterBuildMessage"("buildId","createdAt")`,
  ];
  for (const sql of stmts) {
    try { await prisma.$executeRawUnsafe(sql); }
    catch (e) { console.warn("[db] MB DDL skipped:", (e as any)?.message ?? e); }
  }
}

/**
 * One-time bootstrap that creates the Operate tables on SQLite if they
 * don't exist yet. Idempotent — safe to call on every cold start. When
 * the user eventually runs `npx prisma db push` the tables are already
 * there (matching schema.prisma) and Prisma sees them as in-sync.
 *
 * Postgres deployments will re-create through the normal migration path
 * (`prisma migrate deploy`) on next release; this shortcut targets the
 * dev-SQLite "cold-start with new schema" gap so demos never break.
 */
// Process-level guard: HMR re-imports lib/db.ts on every saved file in dev,
// which would re-run the entire DDL bootstrap and spew duplicate-column
// errors. Stash the "already ran" flag on globalThis so it survives module
// re-evaluation within the same Node process.
async function ensureOperateTables() {
  const url = process.env.DATABASE_URL ?? "";
  // Bootstrap only on SQLite — Postgres is migration-managed.
  if (!url.startsWith("file:") && !url.endsWith(".db")) return;
  const g = globalThis as any;
  if (g.__curfOperateDDLDone) return;
  g.__curfOperateDDLDone = true;

  // Pre-load the existing column set per table so the ALTER TABLE list
  // below can skip ADD COLUMN statements for columns that already exist.
  // Prisma logs prisma:error BEFORE our try/catch can swallow the throw,
  // so a per-call PRAGMA check is the only way to keep the dev console
  // clean on long-lived workspaces.
  const existingCols: Record<string, Set<string>> = {};
  async function loadCols(table: string) {
    if (existingCols[table]) return;
    try {
      const rows: any[] = await prisma.$queryRawUnsafe(`PRAGMA table_info("${table}")`);
      existingCols[table] = new Set((rows ?? []).map((r) => String(r.name)));
    } catch {
      existingCols[table] = new Set(); // table probably doesn't exist yet — CREATE TABLE will follow
    }
  }
  for (const t of ["ActionTemplate", "ActionRequest", "ActionApproval", "MarketplaceTemplate"]) {
    await loadCols(t);
  }
  const skipIfExists = (sql: string): boolean => {
    const m = sql.match(/ALTER TABLE\s+"([^"]+)"\s+ADD COLUMN\s+"([^"]+)"/i);
    if (!m) return false;
    const [, table, col] = m;
    return !!existingCols[table]?.has(col);
  };
  const stmts: string[] = [
    `CREATE TABLE IF NOT EXISTS "ActionTemplate" (
      "id" TEXT PRIMARY KEY,
      "tenantId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "slug" TEXT NOT NULL,
      "description" TEXT,
      "triggerKind" TEXT NOT NULL DEFAULT 'manual',
      "triggerConfigJson" TEXT NOT NULL DEFAULT '{}',
      "inputSchemaJson" TEXT NOT NULL DEFAULT '[]',
      "approvalChainJson" TEXT NOT NULL DEFAULT '[]',
      "destinationKind" TEXT NOT NULL DEFAULT 'http_webhook',
      "destinationConfigJson" TEXT NOT NULL DEFAULT '{}',
      "payloadTemplateJson" TEXT NOT NULL DEFAULT '{}',
      "slaMinutes" INTEGER,
      "dryRun" INTEGER NOT NULL DEFAULT 0,
      "enabled" INTEGER NOT NULL DEFAULT 1,
      "iconKind" TEXT,
      "colorTag" TEXT,
      "compensatingTemplateSlug" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "createdById" TEXT
    )`,
    // Idempotent column add for tenants on a pre-R4 DB. SQLite raises if
    // the column already exists, which we swallow in the catch block above.
    `ALTER TABLE "ActionTemplate" ADD COLUMN "compensatingTemplateSlug" TEXT`,
    // Slack approvals: per-template channel override. null falls back to
    // SlackInstallation.defaultChannelId. Idempotent ADD COLUMN for old DBs.
    `ALTER TABLE "ActionTemplate" ADD COLUMN "slackApprovalChannelId" TEXT`,
    // C4 — document generation config (null = off). Idempotent ADD COLUMN for old DBs.
    `ALTER TABLE "ActionTemplate" ADD COLUMN "documentGenerationJson" TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "ActionTemplate_tenantId_slug_key" ON "ActionTemplate"("tenantId","slug")`,
    `CREATE INDEX IF NOT EXISTS "ActionTemplate_tenantId_enabled_idx" ON "ActionTemplate"("tenantId","enabled")`,
    `CREATE TABLE IF NOT EXISTS "ActionRequest" (
      "id" TEXT PRIMARY KEY,
      "tenantId" TEXT NOT NULL,
      "templateId" TEXT NOT NULL,
      "templateName" TEXT NOT NULL,
      "inputJson" TEXT NOT NULL DEFAULT '{}',
      "chainSnapshotJson" TEXT NOT NULL DEFAULT '[]',
      "destinationKind" TEXT NOT NULL,
      "destinationConfigSnapshotJson" TEXT NOT NULL DEFAULT '{}',
      "payloadSnapshotJson" TEXT NOT NULL DEFAULT '{}',
      "status" TEXT NOT NULL DEFAULT 'pending',
      "currentStep" INTEGER NOT NULL DEFAULT 0,
      "dryRun" INTEGER NOT NULL DEFAULT 0,
      "idempotencyKey" TEXT NOT NULL UNIQUE,
      "contextJson" TEXT NOT NULL DEFAULT '{}',
      "slaMinutes" INTEGER,
      "slaBreachAt" DATETIME,
      "requestedById" TEXT,
      "requestedByEmail" TEXT,
      "reason" TEXT,
      "errorMessage" TEXT,
      "finishedAt" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS "ActionRequest_tenantId_status_idx" ON "ActionRequest"("tenantId","status")`,
    `CREATE INDEX IF NOT EXISTS "ActionRequest_tenantId_createdAt_idx" ON "ActionRequest"("tenantId","createdAt")`,
    `CREATE INDEX IF NOT EXISTS "ActionRequest_templateId_createdAt_idx" ON "ActionRequest"("templateId","createdAt")`,
    // SLA breach tracking — idempotent ADD COLUMN for old DBs.
    `ALTER TABLE "ActionRequest" ADD COLUMN "slaBreachNotifiedAt" DATETIME`,
    `CREATE INDEX IF NOT EXISTS "ActionRequest_tenantId_slaBreachAt_idx" ON "ActionRequest"("tenantId","slaBreachAt")`,
    // Why-this-matters digest — idempotent ADD COLUMN for old DBs.
    `ALTER TABLE "ActionRequest" ADD COLUMN "whyDigest" TEXT`,
    `CREATE TABLE IF NOT EXISTS "ActionApproval" (
      "id" TEXT PRIMARY KEY,
      "tenantId" TEXT NOT NULL,
      "requestId" TEXT NOT NULL,
      "step" INTEGER NOT NULL,
      "approverKind" TEXT NOT NULL,
      "approverValue" TEXT NOT NULL,
      "decision" TEXT NOT NULL DEFAULT 'pending',
      "decidedById" TEXT,
      "decidedByEmail" TEXT,
      "comment" TEXT,
      "decidedAt" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS "ActionApproval_requestId_step_idx" ON "ActionApproval"("requestId","step")`,
    `CREATE INDEX IF NOT EXISTS "ActionApproval_tenantId_decision_idx" ON "ActionApproval"("tenantId","decision")`,
    // Slack approvals: store the (channel, ts) pair Slack returned from
    // chat.postMessage so we can chat.update the same card to reflect
    // the eventual decision. Idempotent ADD COLUMNs for old DBs.
    `ALTER TABLE "ActionApproval" ADD COLUMN "slackChannelId" TEXT`,
    `ALTER TABLE "ActionApproval" ADD COLUMN "slackMessageTs" TEXT`,
    // SLA tracking — origin for the per-step breach timer + anti-spam
    // stamps. Idempotent ADD COLUMNs for old DBs.
    `ALTER TABLE "ActionApproval" ADD COLUMN "stepStartedAt" DATETIME`,
    `ALTER TABLE "ActionApproval" ADD COLUMN "slaReminderSentAt" DATETIME`,
    `ALTER TABLE "ActionApproval" ADD COLUMN "breachedAt" DATETIME`,
    `CREATE INDEX IF NOT EXISTS "ActionApproval_tenantId_breachedAt_idx" ON "ActionApproval"("tenantId","breachedAt")`,
    `CREATE TABLE IF NOT EXISTS "ActionExecution" (
      "id" TEXT PRIMARY KEY,
      "tenantId" TEXT NOT NULL,
      "requestId" TEXT NOT NULL,
      "attempt" INTEGER NOT NULL DEFAULT 1,
      "status" TEXT NOT NULL,
      "destinationKind" TEXT NOT NULL,
      "payloadJson" TEXT NOT NULL DEFAULT '{}',
      "responseJson" TEXT NOT NULL DEFAULT '{}',
      "errorMessage" TEXT,
      "durationMs" INTEGER,
      "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "finishedAt" DATETIME
    )`,
    `CREATE INDEX IF NOT EXISTS "ActionExecution_requestId_attempt_idx" ON "ActionExecution"("requestId","attempt")`,
    `CREATE INDEX IF NOT EXISTS "ActionExecution_tenantId_startedAt_idx" ON "ActionExecution"("tenantId","startedAt")`,
    // Marketplace: discriminator between "report" templates and "operate"
    // (Curf Operate workflow) templates. Idempotent ADD COLUMN — old rows
    // default to "report", which preserves every existing publish.
    `ALTER TABLE "MarketplaceTemplate" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'report'`,
  ];
  for (const sql of stmts) {
    if (skipIfExists(sql)) continue;
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (e) {
      // Don't fatal-error the whole module if one DDL trips on Postgres.
      console.warn("[db] operate DDL skipped:", (e as any)?.message ?? e);
    }
  }
}

function attachRawShim(prop: string, table: string, columns: string[]) {
  const p = prisma as any;
  // In dev, allow the shim to be replaced when db.ts hot-reloads with a
  // new column allowlist. The check below would otherwise lock in the
  // first allowlist forever. Detect a previous shim by the `__curfShim`
  // marker we set below and overwrite it. Real Prisma delegates have
  // no `__curfShim` flag and remain untouched.
  if (process.env.NODE_ENV !== "production" && p[prop]?.__curfShim) {
    delete p[prop];
  }
  if (p[prop] && typeof p[prop].findMany === "function") return; // real delegate present
  const cidPrefix = `cl${Math.random().toString(36).slice(2, 8)}`;
  let counter = 0;
  const newCid = () => `${cidPrefix}${(counter++).toString(36)}${Date.now().toString(36)}`;

  function whereSql(where: any): { sql: string; params: any[] } {
    if (!where) return { sql: "", params: [] };
    const parts: string[] = [];
    const params: any[] = [];
    for (const k of Object.keys(where)) {
      const v = (where as any)[k];
      if (v === null || v === undefined) continue;
      // Composite unique input like { tenantId_name: { tenantId, name } }
      if (typeof v === "object" && !Array.isArray(v)) {
        for (const subKey of Object.keys(v)) {
          parts.push(`"${subKey}" = ?`);
          params.push((v as any)[subKey]);
        }
        continue;
      }
      parts.push(`"${k}" = ?`);
      params.push(v);
    }
    return { sql: parts.length ? ` WHERE ${parts.join(" AND ")}` : "", params };
  }

  function rowFromQuery(row: any): any {
    const out: any = {};
    for (const c of columns) {
      const v = row[c];
      if (v === undefined) continue;
      // SQLite stores DATETIMEs as ISO strings; cast to Date for the
      // few we know are dates.
      if ((c === "createdAt" || c === "updatedAt" || c === "lastQueriedAt" || c === "lastPushedAt") && v) {
        out[c] = new Date(v);
      } else {
        out[c] = v;
      }
    }
    return out;
  }

  p[prop] = {
    /** Marker so dev hot-reload can detect a stale shim and replace it. */
    __curfShim: true,
    async findMany(args: any = {}) {
      const w = whereSql(args.where);
      const orderClauses: string[] = [];
      if (args.orderBy) {
        const o = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy];
        for (const ob of o) {
          for (const k of Object.keys(ob)) orderClauses.push(`"${k}" ${(ob as any)[k] === "asc" ? "ASC" : "DESC"}`);
        }
      }
      const order = orderClauses.length ? ` ORDER BY ${orderClauses.join(", ")}` : "";
      const limit = args.take ? ` LIMIT ${Number(args.take)}` : "";
      const sql = `SELECT * FROM "${table}"${w.sql}${order}${limit}`;
      const rows = await prisma.$queryRawUnsafe<any[]>(toDriverSql(sql), ...w.params);
      return rows.map(rowFromQuery);
    },
    async findFirst(args: any = {}) {
      const list = await this.findMany({ ...args, take: 1 });
      return list[0] ?? null;
    },
    async findUnique(args: any = {}) {
      return this.findFirst(args);
    },
    async count(args: any = {}) {
      const w = whereSql(args.where);
      const sql = `SELECT COUNT(*) as c FROM "${table}"${w.sql}`;
      const rows = await prisma.$queryRawUnsafe<any[]>(toDriverSql(sql), ...w.params);
      return Number(rows[0]?.c ?? 0);
    },
    async create(args: any) {
      const data = { ...(args.data ?? {}) };
      if (!data.id) data.id = newCid();
      const now = new Date().toISOString();
      if (columns.includes("createdAt") && data.createdAt === undefined) data.createdAt = now;
      if (columns.includes("updatedAt") && data.updatedAt === undefined) data.updatedAt = now;
      // Default-fill columns with schema defaults that we know about.
      if (columns.includes("schemaJson") && data.schemaJson === undefined) data.schemaJson = "[]";
      if (columns.includes("tagsJson") && data.tagsJson === undefined) data.tagsJson = "[]";
      if (columns.includes("isCurated") && data.isCurated === undefined) data.isCurated = false;
      if (columns.includes("enabled") && data.enabled === undefined) data.enabled = true;
      if (columns.includes("lastPushOk") && data.lastPushOk === undefined) data.lastPushOk = true;
      const cols = Object.keys(data).filter((k) => columns.includes(k));
      const placeholders = cols.map(() => "?").join(", ");
      const sql = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`;
      const params = cols.map((c) => {
        const v = (data as any)[c];
        if (v instanceof Date) return v.toISOString();
        if (typeof v === "boolean") return v ? 1 : 0;
        return v;
      });
      await prisma.$executeRawUnsafe(toDriverSql(sql), ...params);
      const row = await this.findUnique({ where: { id: data.id } });
      // Apply args.select if provided.
      if (args.select && row) {
        const out: any = {};
        for (const k of Object.keys(args.select)) if ((args.select as any)[k]) out[k] = row[k];
        return out;
      }
      return row;
    },
    async update(args: any) {
      const where = whereSql(args.where);
      const data = { ...(args.data ?? {}) };
      if (columns.includes("updatedAt")) data.updatedAt = new Date().toISOString();
      const cols = Object.keys(data).filter((k) => columns.includes(k));
      const set = cols.map((c) => `"${c}" = ?`).join(", ");
      const sql = `UPDATE "${table}" SET ${set}${where.sql}`;
      const params = [
        ...cols.map((c) => {
          const v = (data as any)[c];
          if (v instanceof Date) return v.toISOString();
          if (typeof v === "boolean") return v ? 1 : 0;
          return v;
        }),
        ...where.params,
      ];
      await prisma.$executeRawUnsafe(toDriverSql(sql), ...params);
      return await this.findFirst({ where: args.where });
    },
    async delete(args: any) {
      const w = whereSql(args.where);
      const row = await this.findFirst({ where: args.where });
      const sql = `DELETE FROM "${table}"${w.sql}`;
      await prisma.$executeRawUnsafe(toDriverSql(sql), ...w.params);
      return row;
    },
    async deleteMany(args: any = {}) {
      const w = whereSql(args.where);
      const sql = `DELETE FROM "${table}"${w.sql}`;
      const result: any = await prisma.$executeRawUnsafe(toDriverSql(sql), ...w.params);
      return { count: Number(result ?? 0) };
    },
  };
}
