import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import { prisma } from "@/lib/db";
import { ee } from "@/ee";
import { requireUser, tenantWhere, getUserRoles, blockScopedApiKey } from "@/lib/auth";
import { canSeeDataSource } from "@/lib/datasourceAcl";

/**
 * GET /api/reports/generate/inventory
 *
 * Lightweight introspection used by the Generate modal to show "Curf can see
 * X tables across Y connections". Same walk as the full generate route does,
 * minus the column types and sample rows — we only need names + counts here.
 *
 * Falls back to {connections, tables: []} if any single source can't be
 * inspected, so a broken connection doesn't blank out the whole modal.
 */
export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // No existing report id to check against — this enumerates every tenant
  // data source/table, well beyond what a report-scoped key should reach.
  const scopeBlock = blockScopedApiKey(user);
  if (scopeBlock) return scopeBlock;

  // Tolerate the missing discoveredSchemaJson column pre db-push: fall back
  // to a select without it, REST connections just won't show fields yet.
  let allDataSources: any[];
  try {
    allDataSources = await prisma.dataSource.findMany({
      where: tenantWhere(user),
      select: {
        id: true, name: true, kind: true, connection: true, discoveredSchemaJson: true,
        visibleToRolesJson: true, ownerUserId: true,
      },
    });
  } catch {
    allDataSources = await prisma.dataSource.findMany({
      where: tenantWhere(user),
      select: { id: true, name: true, kind: true, connection: true },
    });
  }

  // Filter through the visibility ACL — sources the user can't see should
  // not even appear in "Curf can see" totals or the source picker.
  const userRoles = await getUserRoles();
  const isAdmin = (user as any).role === "admin";
  const dataSources = allDataSources.filter((d: any) =>
    canSeeDataSource(d, { id: user.id, isAdmin, roles: userRoles }),
  );

  type Conn = {
    id: string;
    name: string;
    kind: string;
    tables: string[];
    /** REST only: the inferred field list, when previously probed. */
    fields?: Array<{ name: string; type: string }>;
    schemaProbed?: boolean;
  };
  const connections: Conn[] = [];
  for (const ds of dataSources) {
    // Excel imports live in a per-tenant SQLite file under var/tenants/, so
    // they're enumerated identically to native SQLite via PRAGMA.
    if (ds.kind === "sqlite" || ds.kind === "excel") {
      connections.push({ id: ds.id, name: ds.name, kind: ds.kind, tables: listTablesSafe(ds) });
    } else if (ds.kind === "postgres") {
      connections.push({ id: ds.id, name: ds.name, kind: ds.kind, tables: await listPgTablesSafe(ds) });
    } else if (ds.kind === "mysql") {
      connections.push({ id: ds.id, name: ds.name, kind: ds.kind, tables: await listMyTablesSafe(ds) });
    } else if (ee.connectors?.warehouses[ds.kind]) {
      // Snowflake / BigQuery live in the paid edition (src/ee/connectors).
      const tables = await ee.connectors.warehouses[ds.kind].listTables(ds.connection, 100).catch(() => [] as string[]);
      connections.push({ id: ds.id, name: ds.name, kind: ds.kind, tables });
    } else if (ds.kind === "rest") {
      let fields: Array<{ name: string; type: string }> = [];
      let schemaProbed = false;
      if (ds.discoveredSchemaJson) {
        try {
          const parsed = JSON.parse(ds.discoveredSchemaJson) as { fields?: Array<{ name: string; type: string }> };
          fields = parsed.fields ?? [];
          schemaProbed = fields.length > 0;
        } catch { /* ignore corrupt JSON */ }
      }
      connections.push({ id: ds.id, name: ds.name, kind: ds.kind, tables: [], fields, schemaProbed });
    } else {
      connections.push({ id: ds.id, name: ds.name, kind: ds.kind, tables: [] });
    }
  }

  // Total "tables" counts file-backed + warehouse tables AND REST endpoints
  // with discovered schema.
  const totalTables = connections.reduce((s, c) => {
    if (c.kind === "sqlite" || c.kind === "excel" || c.kind === "postgres" || c.kind === "mysql" || c.kind === "snowflake" || c.kind === "bigquery") return s + c.tables.length;
    if (c.kind === "rest" && c.schemaProbed) return s + 1;
    return s;
  }, 0);
  return NextResponse.json({
    totalConnections: connections.length,
    totalTables,
    connections,
  });
}

function listTablesSafe(ds: { kind: string; connection: string }): string[] {
  // SQLite and Excel both have a real .db file at `connection`; REST does not.
  if (ds.kind !== "sqlite" && ds.kind !== "excel") return [];
  let db: any = null;
  try {
    db = new Database(ds.connection, { readonly: true, fileMustExist: true });
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 100")
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  } catch {
    return [];
  } finally {
    if (db) try { db.close(); } catch { /* ignore */ }
  }
}

/**
 * List MySQL tables in the configured database. Same shape + best-effort
 * semantics as the Postgres variant.
 */
async function listMyTablesSafe(ds: { connection: string }): Promise<string[]> {
  try {
    const { createConnection } = await import("mysql2/promise");
    const { decodeMyConnection, resolveMyClientConfig } = await import("@/lib/connections/mysql");
    const stored = decodeMyConnection(ds.connection);
    const conn = await createConnection(resolveMyClientConfig(stored));
    try {
      const [rows] = await conn.query(
        "SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY TABLE_NAME LIMIT 100",
        [stored.database],
      );
      return (rows as any[]).map((r) => r.TABLE_NAME ?? r.table_name);
    } finally {
      try { await conn.end(); } catch { /* ignore */ }
    }
  } catch {
    return [];
  }
}



/**
 * List Postgres tables in the configured schema. Same shape as the SQLite
 * variant — best-effort, swallows errors so a flaky network or wrong
 * password just yields an empty count rather than blanking the inventory.
 */
async function listPgTablesSafe(ds: { connection: string }): Promise<string[]> {
  try {
    const { Client: PgClient } = await import("pg");
    const { decodePgConnection, resolvePgClientConfig } = await import("@/lib/connections/postgres");
    const stored = decodePgConnection(ds.connection);
    const client = new PgClient(resolvePgClientConfig(stored));
    await client.connect();
    try {
      const result = await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name LIMIT 100",
        [stored.schema],
      );
      return result.rows.map((r: any) => r.table_name);
    } finally {
      try { await client.end(); } catch { /* ignore */ }
    }
  } catch {
    return [];
  }
}
