import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin, getUserRoles } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { writeVisibility, canSeeDataSource, type Visibility } from "@/lib/datasourceAcl";
import { joinRestUrl } from "@/lib/reporting/restUrl";
import { encodeRestConnection, decodeRestConnection, resolveRestHeaders, maskRestConnectionForClient } from "@/lib/connections/rest";
import { encodePgConnection, maskPgConnectionForClient } from "@/lib/connections/postgres";
import { encodeMyConnection, maskMyConnectionForClient } from "@/lib/connections/mysql";
import { guardedFetch } from "@/lib/security/ssrfGuard";
import { ee } from "@/ee";
import { paidConnector, unsupportedKindResponse } from "@/lib/connections/paid";

// Same preset resolver as data-sources/route.ts's create path — see that
// file's comment for why HubSpot/Zendesk are "rest" presets, not their own
// DataSource.kind.
const RestPresetInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hubspot"), accessToken: z.string().min(1) }),
  z.object({ kind: z.literal("zendesk"), subdomain: z.string().min(1), email: z.string().email(), apiToken: z.string().min(1) }),
]).optional();

function resolveRestPreset(preset: z.infer<typeof RestPresetInputSchema>): { baseUrl: string; headers: Record<string, string>; presetKind: "hubspot" | "zendesk" } | null {
  if (!preset) return null;
  // HubSpot / Zendesk presets are paid connectors (src/ee/connectors).
  const r = ee.connectors?.restPreset?.(preset);
  return r ? { baseUrl: r.baseUrl, headers: r.headers, presetKind: r.presetKind as "hubspot" | "zendesk" } : null;
}

function safeParseJson<T = unknown>(s: string): T | null {
  try { return JSON.parse(s) as T; } catch { return null; }
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const row = await prisma.dataSource.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Surface visibility so the edit form can pre-populate the radio + chips.
  // The owner_only mode also tells the client whether the current user IS
  // the owner (for the "Just me" label).
  const visibility = (row as any).ownerUserId
    ? { mode: "owner_only" as const, ownerUserId: (row as any).ownerUserId, isOwner: (row as any).ownerUserId === user.id }
    : ((row as any).visibleToRolesJson && (row as any).visibleToRolesJson !== "[]")
      ? (() => {
          let roles: string[] = [];
          try {
            const parsed = JSON.parse((row as any).visibleToRolesJson);
            if (Array.isArray(parsed)) roles = parsed.filter((s) => typeof s === "string");
          } catch { /* corrupt */ }
          return roles.length > 0 ? { mode: "roles" as const, roles } : { mode: "tenant" as const };
        })()
      : { mode: "tenant" as const };

  if (row.kind === "rest") {
    // Header VALUES (bearer tokens, API keys) never round-trip to the
    // client — only the names, mirroring how Postgres/MySQL mask passwords.
    let rest: ReturnType<typeof maskRestConnectionForClient> | null = null;
    try { rest = maskRestConnectionForClient(row.connection); }
    catch { rest = null; }
    return NextResponse.json({
      id: row.id,
      name: row.name,
      kind: row.kind,
      baseUrl: rest?.baseUrl ?? "",
      headerKeys: rest?.headerKeys ?? [],
      hasHeaders: rest?.hasHeaders ?? false,
      presetKind: rest?.presetKind,
      visibility,
      readOnly: row.readOnly,
      createdAt: row.createdAt,
    });
  }
  if (row.kind === "postgres") {
    // Surface host/port/database/user/schema/ssl + a hasPassword flag. The
    // password ciphertext stays server-side; the form lets admins re-type
    // only when they want to rotate it.
    let pg: ReturnType<typeof maskPgConnectionForClient> | null = null;
    try { pg = maskPgConnectionForClient(row.connection); }
    catch { pg = null; }
    return NextResponse.json({
      id: row.id,
      name: row.name,
      kind: row.kind,
      pg,
      visibility,
      createdAt: row.createdAt,
    });
  }
  if (row.kind === "mysql") {
    let my: ReturnType<typeof maskMyConnectionForClient> | null = null;
    try { my = maskMyConnectionForClient(row.connection); }
    catch { my = null; }
    return NextResponse.json({
      id: row.id,
      name: row.name,
      kind: row.kind,
      my,
      visibility,
      createdAt: row.createdAt,
    });
  }
  if (row.kind === "snowflake") {
    let sf: Record<string, unknown> | null = null;
    try { sf = paidConnector("snowflake")?.mask(row.connection) ?? null; }
    catch { sf = null; }
    return NextResponse.json({
      id: row.id,
      name: row.name,
      kind: row.kind,
      sf,
      visibility,
      createdAt: row.createdAt,
    });
  }
  if (row.kind === "bigquery") {
    let bq: Record<string, unknown> | null = null;
    try { bq = paidConnector("bigquery")?.mask(row.connection) ?? null; }
    catch { bq = null; }
    return NextResponse.json({
      id: row.id,
      name: row.name,
      kind: row.kind,
      bq,
      visibility,
      createdAt: row.createdAt,
    });
  }
  if (row.kind === "sftp") {
    let sftp: Record<string, unknown> | null = null;
    try { sftp = paidConnector("sftp")?.mask(row.connection) ?? null; }
    catch { sftp = null; }
    return NextResponse.json({
      id: row.id,
      name: row.name,
      kind: row.kind,
      sftp,
      visibility,
      createdAt: row.createdAt,
    });
  }
  return NextResponse.json({
    id: row.id,
    name: row.name,
    kind: row.kind,
    connection: row.connection,
    visibility,
    createdAt: row.createdAt,
  });
}

// Visibility update is allowed for any kind, including Excel — the kind
// itself doesn't change, only who can see the source. owner_only binds to
// the user issuing the PATCH so admins explicitly transferring an upload to
// themselves is the supported flow.
const VisibilityInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("tenant") }),
  z.object({ mode: z.literal("roles"), roles: z.array(z.string().min(1)).min(1) }),
  z.object({ mode: z.literal("owner_only") }),
]).optional();

const PatchSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sqlite"),
    name: z.string().min(1).optional(),
    connection: z.string().min(1).optional(),
    visibility: VisibilityInputSchema,
  }),
  z.object({
    kind: z.literal("rest"),
    name: z.string().min(1).optional(),
    baseUrl: z.string().url().optional(),
    headers: z.record(z.string()).optional(),
    visibility: VisibilityInputSchema,
    readOnly: z.boolean().optional(),
    // Guided HubSpot/Zendesk re-setup (e.g. rotating a token) — see
    // resolveRestPreset() above.
    preset: RestPresetInputSchema,
  }),
  // Excel rows can have name + visibility patched (connection is the on-disk
  // dbPath, never editable here — refresh-from-file handles data updates).
  z.object({
    kind: z.literal("excel"),
    name: z.string().min(1).optional(),
    visibility: VisibilityInputSchema,
  }),
  // Postgres edit. Password is optional — empty/missing means "keep the
  // existing encrypted password"; only re-encrypt when a fresh value is
  // supplied. host/database/etc are optional too so PATCH can be partial.
  z.object({
    kind: z.literal("postgres"),
    name: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    port: z.number().int().positive().optional(),
    database: z.string().min(1).optional(),
    user: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    schema: z.string().optional(),
    ssl: z.boolean().optional(),
    visibility: VisibilityInputSchema,
  }),
  z.object({
    kind: z.literal("mysql"),
    name: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    port: z.number().int().positive().optional(),
    database: z.string().min(1).optional(),
    user: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    ssl: z.boolean().optional(),
    visibility: VisibilityInputSchema,
  }),
  // Snowflake edit. Same password-rotate convention as Postgres/MySQL —
  // empty/missing reuses the existing encrypted password. Account locator
  // is stored as-typed (it goes into the snowflake-sdk hostname).
  z.object({
    kind: z.literal("snowflake"),
    name: z.string().min(1).optional(),
    account: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    warehouse: z.string().min(1).optional(),
    database: z.string().min(1).optional(),
    schema: z.string().optional(),
    role: z.string().optional(),
    visibility: VisibilityInputSchema,
  }),
  // BigQuery edit. credentialsJson follows the same rotate convention:
  // empty/missing reuses the existing encrypted blob. Project/dataset are
  // freely editable since they don't unlock anything secret.
  z.object({
    kind: z.literal("bigquery"),
    name: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    dataset: z.string().min(1).optional(),
    location: z.string().optional(),
    credentialsJson: z.string().min(1).optional(),
    visibility: VisibilityInputSchema,
  }),
  // SFTP edit. Same rotate-or-keep convention — a blank password/privateKey
  // reuses the existing encrypted secret. Switching authMethod without
  // supplying the new method's secret is rejected by encodeSftpConnection().
  z.object({
    kind: z.literal("sftp"),
    name: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    port: z.number().int().positive().optional(),
    username: z.string().min(1).optional(),
    authMethod: z.enum(["password", "privateKey"]).optional(),
    password: z.string().min(1).optional(),
    privateKey: z.string().min(1).optional(),
    passphrase: z.string().optional(),
    remotePath: z.string().min(1).optional(),
    visibility: VisibilityInputSchema,
  }),
]);

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const existing = await prisma.dataSource.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });
  }

  if (parsed.data.kind !== existing.kind) {
    return NextResponse.json({ error: "Cannot change connection kind; delete and recreate." }, { status: 400 });
  }

  const data: { name?: string; connection?: string; visibleToRolesJson?: string; ownerUserId?: string | null; readOnly?: boolean } = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;

  if (parsed.data.kind === "rest") {
    if (parsed.data.readOnly !== undefined) data.readOnly = parsed.data.readOnly;
    // encodeRestConnection reuses the existing encrypted headers when
    // `headers` is omitted (undefined) — same "leave blank to keep" contract
    // as the Postgres/MySQL password fields. A `preset` (rotating a
    // HubSpot/Zendesk token) overrides baseUrl/headers entirely.
    const restPreset = resolveRestPreset(parsed.data.preset);
    let existingBaseUrl = "";
    try { existingBaseUrl = decodeRestConnection(existing.connection).baseUrl; } catch { /* corrupt — require a fresh baseUrl */ }
    data.connection = encodeRestConnection(
      restPreset
        ? { baseUrl: restPreset.baseUrl, headers: restPreset.headers, presetKind: restPreset.presetKind }
        : { baseUrl: parsed.data.baseUrl ?? existingBaseUrl, headers: parsed.data.headers },
      existing.connection,
    );
  } else if (parsed.data.kind === "sqlite") {
    if (parsed.data.connection !== undefined) data.connection = parsed.data.connection;
  } else if (parsed.data.kind === "postgres") {
    // Merge supplied fields onto the stored shape. encodePgConnection
    // reuses the existing passwordEnc when no fresh password is provided.
    const stored = safeParseJson<any>(existing.connection) ?? {};
    data.connection = encodePgConnection(
      {
        host: parsed.data.host ?? stored.host,
        port: parsed.data.port ?? stored.port,
        database: parsed.data.database ?? stored.database,
        user: parsed.data.user ?? stored.user,
        password: parsed.data.password,
        schema: parsed.data.schema ?? stored.schema,
        ssl: parsed.data.ssl ?? stored.ssl,
      },
      existing.connection,
    );
  } else if (parsed.data.kind === "mysql") {
    const stored = safeParseJson<any>(existing.connection) ?? {};
    data.connection = encodeMyConnection(
      {
        host: parsed.data.host ?? stored.host,
        port: parsed.data.port ?? stored.port,
        database: parsed.data.database ?? stored.database,
        user: parsed.data.user ?? stored.user,
        password: parsed.data.password,
        ssl: parsed.data.ssl ?? stored.ssl,
      },
      existing.connection,
    );
  } else if (parsed.data.kind === "snowflake" || parsed.data.kind === "bigquery" || parsed.data.kind === "sftp") {
    // Paid connectors own their credential merge (partial patch over the
    // stored connection) — see src/ee/connectors.
    const connector = paidConnector(parsed.data.kind);
    if (!connector) return unsupportedKindResponse(parsed.data.kind);
    data.connection = connector.encodeUpdate(parsed.data, existing.connection);
  }
  // Excel: no connection-shape fields; refresh-from-file handles data updates.

  // Visibility (any kind): owner_only is bound to the CURRENT user. If an
  // admin transfers ownership to themselves they explicitly issue the PATCH.
  if (parsed.data.visibility) {
    const v: Visibility =
      parsed.data.visibility.mode === "tenant"     ? { mode: "tenant" }
    : parsed.data.visibility.mode === "owner_only" ? { mode: "owner_only", ownerUserId: user.id }
    :                                                { mode: "roles", roles: parsed.data.visibility.roles };
    const acl = writeVisibility(v);
    data.visibleToRolesJson = acl.visibleToRolesJson;
    data.ownerUserId        = acl.ownerUserId;
  }

  try {
    const updated = await prisma.dataSource.update({ where: { id: params.id }, data });
    recordAudit({
      user, kind: "datasource.update", target: params.id, req,
      meta: {
        name: updated.name, kind: updated.kind, fields: Object.keys(data),
        visibility: parsed.data.visibility?.mode,
        visibleToRoles: parsed.data.visibility?.mode === "roles" ? parsed.data.visibility.roles : undefined,
      },
    });
    return NextResponse.json({ id: updated.id, name: updated.name, kind: updated.kind });
  } catch (e: any) {
    if (e?.code === "P2002") {
      return NextResponse.json(
        { error: 'A connection named "' + parsed.data.name + '" already exists.' },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: e?.message ?? "Failed to update" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;
  const existing = await prisma.dataSource.findFirst({
    where: { id: params.id, tenantId: user.tenantId },
    select: { id: true, name: true, kind: true, connection: true },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    await prisma.dataSource.delete({ where: { id: params.id } });
    // For Excel imports, the SQLite file lives under var/tenants/<id>/uploads/.
    // Clean it up so deleted connections don't leave orphan .db files on disk.
    // Best-effort: a stale file on disk is annoying but not a correctness bug,
    // so we don't block the response on filesystem errors.
    if (existing.kind === "excel" && existing.connection) {
      const expectedPrefix = path.join(process.cwd(), "var", "tenants", user.tenantId);
      // Path-traversal guard: only unlink if the connection points inside the
      // tenant's own upload dir. Belt-and-braces — the upload route only ever
      // writes there, but we don't want a malformed connection string to
      // delete something else.
      if (existing.connection.startsWith(expectedPrefix)) {
        try { fs.unlinkSync(existing.connection); } catch { /* file may already be gone */ }
      }
    }
    recordAudit({
      user, kind: "datasource.delete", target: params.id, req,
      meta: { name: existing.name, kind: existing.kind },
    });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Delete failed" }, { status: 400 });
  }
}

// Test endpoints (params.id = "test-rest" or "test-sqlite") run a one-shot
// connection probe without persisting anything; tenant-agnostic.

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Connections are admin-managed. Every test-* action below reaches an
  // outbound fetch (test-rest = SSRF) or opens an arbitrary local file
  // (test-sqlite = filesystem existence/enumeration oracle) with
  // caller-supplied targets — gate them to admins, not any authenticated
  // viewer. (Deeper host/path validation on those sinks is tracked separately.)
  if (user.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  if (params.id === "test-rest") return testRest(req);
  if (params.id === "test-sqlite") return testSqlite(req);
  if (params.id === "test-postgres") return testPostgres(req);
  if (params.id === "test-mysql") return testMysql(req);
  if (params.id.startsWith("test-")) {
    // Paid connectors register their own connection tests.
    const connector = paidConnector(params.id.slice("test-".length));
    if (connector) return connector.test(req);
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

async function testRest(req: NextRequest) {
  const input = await req.json().catch(() => null) as {
    baseUrl?: string;
    headers?: Record<string, string>;
    path?: string;
    method?: string;
    body?: string;
    /** When set, rehydrate the stored encrypted headers (skip plaintext round-trip). */
    dataSourceId?: string;
  } | null;

  let baseUrl = input?.baseUrl;
  let storedHeaders: Record<string, string> = {};
  if (input?.dataSourceId) {
    const user = await requireUser(req);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const row = await prisma.dataSource.findFirst({
      where: { id: input.dataSourceId, tenantId: user.tenantId },
      select: { kind: true, connection: true, visibleToRolesJson: true, ownerUserId: true },
    });
    if (!row || row.kind !== "rest") {
      return NextResponse.json({ error: "REST data source not found" }, { status: 404 });
    }
    // Same ACL every other read of this row goes through (data-sources/route.ts:157)
    // — "Just me" connections don't get an admin bypass just because this is
    // a test-probe endpoint.
    const userRoles = await getUserRoles();
    if (!canSeeDataSource(row, { id: user.id, isAdmin: user.role === "admin", roles: userRoles })) {
      return NextResponse.json({ error: "REST data source not found" }, { status: 404 });
    }
    try {
      const stored = decodeRestConnection(row.connection);
      // The caller may still narrow *within* the stored connection (a
      // relative path, or an absolute one on the same host — joinRestUrl
      // enforces that below) but may not point stored credentials at a
      // baseUrl of their own choosing. Testing a not-yet-saved connection
      // (no dataSourceId) is unrestricted, since no stored secret travels
      // with it.
      baseUrl = stored.baseUrl;
      storedHeaders = resolveRestHeaders(stored);
    } catch (e: any) {
      return NextResponse.json({ error: e?.message ?? "Could not resolve connection" }, { status: 400 });
    }
  }

  if (!baseUrl) return NextResponse.json({ error: "baseUrl required" }, { status: 400 });

  const method = (input?.method ?? "POST").toUpperCase();
  const headers: Record<string, string> = { Accept: "application/json", ...storedHeaders, ...(input?.headers ?? {}) };
  let body: string | undefined;
  if (method !== "GET" && input?.body) {
    body = input.body;
    if (!("Content-Type" in headers || "content-type" in headers)) {
      try { JSON.parse(body); headers["Content-Type"] = "application/json"; }
      catch { headers["Content-Type"] = "text/plain"; }
    }
  }

  try {
    const url = new URL(joinRestUrl(baseUrl, input?.path ?? "/"));
    const started = Date.now();
    const res = await guardedFetch(url.toString(), { method, headers, body });
    const text = await res.text();
    return NextResponse.json({
      ok: res.ok,
      status: res.status,
      durationMs: Date.now() - started,
      method,
      url: url.toString(),
      preview: text.slice(0, 600),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Request failed" }, { status: 400 });
  }
}

async function testSqlite(req: NextRequest) {
  const input = await req.json().catch(() => null) as { connection?: string } | null;
  const path = input?.connection?.trim();
  if (!path) return NextResponse.json({ error: "connection (file path) required" }, { status: 400 });

  const Database = (await import("better-sqlite3")).default;
  const started = Date.now();
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const ping = db.prepare("SELECT 1 AS ok").get() as { ok: number } | undefined;
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      return NextResponse.json({
        ok: ping?.ok === 1,
        durationMs: Date.now() - started,
        url: path,
        preview: tables.length
          ? "Connected. " + tables.length + " table(s): " + tables.map((t) => t.name).join(", ")
          : "Connected. (No tables found.)",
      });
    } finally {
      db.close();
    }
  } catch (e: any) {
    return NextResponse.json({
      error: e?.message ?? "Could not open database",
      durationMs: Date.now() - started,
    }, { status: 400 });
  }
}

/**
 * Postgres connection test. Accepts either a brand-new credential set (host,
 * port, database, user, password, ssl) for the Add-connection form's "Test"
 * button, OR a pre-existing dataSourceId so the Edit form can verify the
 * connection without re-typing the password (the stored encrypted password
 * is decrypted server-side, never sent to the client).
 *
 * Runs SELECT 1 + lists user tables in the named schema (default "public").
 */
async function testPostgres(req: NextRequest) {
  const input = await req.json().catch(() => null) as {
    host?: string; port?: number; database?: string; user?: string;
    password?: string; schema?: string; ssl?: boolean;
    /** When set, rehydrate the stored connection (skip plaintext password). */
    dataSourceId?: string;
  } | null;
  if (!input) return NextResponse.json({ error: "Body required" }, { status: 400 });

  const { Client: PgClient } = await import("pg");
  const { decodePgConnection, resolvePgClientConfig } = await import("@/lib/connections/postgres");

  let cfg: any;
  let schemaName = "public";
  try {
    if (input.dataSourceId) {
      const user = await requireUser(req);
      if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      const row = await prisma.dataSource.findFirst({
        where: { id: input.dataSourceId, tenantId: user.tenantId },
        select: { kind: true, connection: true },
      });
      if (!row || row.kind !== "postgres") {
        return NextResponse.json({ error: "Postgres data source not found" }, { status: 404 });
      }
      const stored = decodePgConnection(row.connection);
      cfg = resolvePgClientConfig(stored);
      schemaName = stored.schema;
    } else {
      if (!input.host || !input.database || !input.user || !input.password) {
        return NextResponse.json({ error: "host, database, user, password required" }, { status: 400 });
      }
      cfg = {
        host: input.host,
        port: input.port ?? 5432,
        database: input.database,
        user: input.user,
        password: input.password,
        ssl: input.ssl ? { rejectUnauthorized: false } : undefined,
        connectionTimeoutMillis: 5_000,
      };
      schemaName = (input.schema ?? "public").trim() || "public";
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Could not resolve connection" }, { status: 400 });
  }

  const started = Date.now();
  const client = new PgClient(cfg);
  try {
    await client.connect();
    const ping = await client.query("SELECT 1 AS ok");
    const tables = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name LIMIT 50",
      [schemaName],
    );
    const names = tables.rows.map((r: any) => r.table_name);
    return NextResponse.json({
      ok: ping.rows[0]?.ok === 1,
      durationMs: Date.now() - started,
      url: `${cfg.host}:${cfg.port}/${cfg.database}` + (cfg.ssl ? " (ssl)" : ""),
      preview: names.length
        ? `Connected. Schema "${schemaName}" — ${names.length} table(s): ` + names.slice(0, 20).join(", ") + (names.length > 20 ? ", …" : "")
        : `Connected. (No tables in schema "${schemaName}".)`,
    });
  } catch (e: any) {
    return NextResponse.json({
      error: e?.message ?? "Could not connect",
      durationMs: Date.now() - started,
    }, { status: 400 });
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
}


/**
 * MySQL connection test. Mirrors testPostgres — accepts plaintext credentials
 * for the Add form, or a stored dataSourceId to rehydrate the encrypted
 * password without round-tripping it through the client.
 */
async function testMysql(req: NextRequest) {
  const input = await req.json().catch(() => null) as {
    host?: string; port?: number; database?: string; user?: string;
    password?: string; ssl?: boolean;
    dataSourceId?: string;
  } | null;
  if (!input) return NextResponse.json({ error: "Body required" }, { status: 400 });

  const { createConnection } = await import("mysql2/promise");
  const { decodeMyConnection, resolveMyClientConfig } = await import("@/lib/connections/mysql");

  let cfg: any;
  let databaseName = "";
  try {
    if (input.dataSourceId) {
      const user = await requireUser(req);
      if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      const row = await prisma.dataSource.findFirst({
        where: { id: input.dataSourceId, tenantId: user.tenantId },
        select: { kind: true, connection: true },
      });
      if (!row || row.kind !== "mysql") {
        return NextResponse.json({ error: "MySQL data source not found" }, { status: 404 });
      }
      const stored = decodeMyConnection(row.connection);
      cfg = resolveMyClientConfig(stored);
      databaseName = stored.database;
    } else {
      if (!input.host || !input.database || !input.user || !input.password) {
        return NextResponse.json({ error: "host, database, user, password required" }, { status: 400 });
      }
      cfg = {
        host: input.host,
        port: input.port ?? 3306,
        database: input.database,
        user: input.user,
        password: input.password,
        ssl: input.ssl ? { rejectUnauthorized: false } : undefined,
        connectTimeout: 5_000,
      };
      databaseName = input.database;
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Could not resolve connection" }, { status: 400 });
  }

  const started = Date.now();
  let conn: any;
  try {
    conn = await createConnection(cfg);
    const [pingRows] = await conn.query("SELECT 1 AS ok");
    const [tableRows] = await conn.query(
      "SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY TABLE_NAME LIMIT 50",
      [databaseName],
    );
    const names = (tableRows as any[]).map((r) => r.TABLE_NAME ?? r.table_name);
    return NextResponse.json({
      ok: Array.isArray(pingRows) && (pingRows as any)[0]?.ok === 1,
      durationMs: Date.now() - started,
      url: `${cfg.host}:${cfg.port}/${cfg.database}` + (cfg.ssl ? " (ssl)" : ""),
      preview: names.length
        ? `Connected. Database "${databaseName}" — ${names.length} table(s): ` + names.slice(0, 20).join(", ") + (names.length > 20 ? ", …" : "")
        : `Connected. (No tables in database "${databaseName}".)`,
    });
  } catch (e: any) {
    return NextResponse.json({
      error: e?.message ?? "Could not connect",
      durationMs: Date.now() - started,
    }, { status: 400 });
  } finally {
    try { if (conn) await conn.end(); } catch { /* ignore */ }
  }
}


