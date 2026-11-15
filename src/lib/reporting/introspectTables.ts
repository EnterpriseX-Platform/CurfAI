/**
 * The table inventory a report-generating prompt is built from: each table's
 * columns and one sample row, for every kind of data source. Lived in
 * api/reports/generate/route.ts until Next 15, which refuses a route file
 * that exports anything but its handlers.
 */
import { prisma } from "@/lib/db";
import type { RunViewer } from "@/lib/reporting/runner";
import { ee } from "@/ee";
import { openTenantSqlite } from "@/lib/connections/sqlitePath";
import { tenantLakeEngine, type LakeEngineName } from "@/lib/lake/tenantEngine";

export type TableSchema = {
  name: string;
  columns: Array<{ name: string; type: string }>;
  sample: Record<string, unknown> | null;
};

export async function introspectTables(
  ds: { id: string; name: string; kind: string; connection: string; discoveredSchemaJson?: string | null; tenantId?: string },
  /** Who the prompt is built for: a lake source lists only the tables they
   *  may read, with their sample rows masked (lib/lake/readableRows.ts).
   *  Callers check the source itself with canSeeDataSource first. */
  viewer: RunViewer,
): Promise<{
  dataSourceName: string;
  kind: string;
  /** Set for a lake source: which engine its SQL runs on, so the prompt can name the right dialect. */
  engine?: LakeEngineName;
  tables: TableSchema[];
}> {
  const out: { dataSourceName: string; kind: string; engine?: LakeEngineName; tables: TableSchema[] } = {
    dataSourceName: ds.name,
    kind: ds.kind,
    tables: [],
  };

  // Postgres: walk information_schema.columns for the configured schema,
  // sample one row per table. Same { name, columns, sample } shape as the
  // SQLite path so the prompt template is unchanged.
  if (ds.kind === "postgres") {
    try {
      const { Client: PgClient } = await import("pg");
      const { decodePgConnection, resolvePgClientConfig } = await import("@/lib/connections/postgres");
      const stored = decodePgConnection(ds.connection);
      const client = new PgClient(resolvePgClientConfig(stored));
      await client.connect();
      try {
        const tables = (await client.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name LIMIT 50",
          [stored.schema],
        )).rows as Array<{ table_name: string }>;
        for (const t of tables) {
          const cols = (await client.query(
            "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
            [stored.schema, t.table_name],
          )).rows as Array<{ column_name: string; data_type: string }>;
          // Quote both schema and table to handle case-sensitive identifiers.
          const sampleResult = await client.query(`SELECT * FROM "${stored.schema}"."${t.table_name}" LIMIT 1`).catch(() => ({ rows: [] }));
          out.tables.push({
            name: t.table_name,
            columns: cols.map((c) => ({ name: c.column_name, type: c.data_type })),
            sample: (sampleResult.rows[0] as Record<string, unknown>) ?? null,
          });
        }
      } finally {
        try { await client.end(); } catch { /* ignore */ }
      }
    } catch { /* swallow — empty inventory better than crash */ }
    return out;
  }



  // MySQL: parallel to the Postgres branch — information_schema.{tables,columns}
  // filtered by table_schema = the configured database. Identifiers are
  // back-ticked when sampling to handle reserved words / mixed case.
  // Warehouse kinds (Snowflake, BigQuery) are paid connectors; their
  // introspection lives in src/ee/connectors and returns the same shape.
  const warehouse = ee.connectors?.warehouses[ds.kind];
  if (warehouse) {
    out.tables = await warehouse.introspect(ds.connection).catch(() => []);
    return out;
  }

  if (ds.kind === "mysql") {
    try {
      const { createConnection } = await import("mysql2/promise");
      const { decodeMyConnection, resolveMyClientConfig } = await import("@/lib/connections/mysql");
      const stored = decodeMyConnection(ds.connection);
      const conn = await createConnection(resolveMyClientConfig(stored));
      try {
        const [tableRows] = await conn.query(
          "SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY TABLE_NAME LIMIT 50",
          [stored.database],
        );
        const tables = (tableRows as any[]).map((r) => r.TABLE_NAME ?? r.table_name) as string[];
        for (const tName of tables) {
          const [colRows] = await conn.query(
            "SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ORDINAL_POSITION",
            [stored.database, tName],
          );
          const cols = (colRows as any[]).map((c) => ({
            name: (c.COLUMN_NAME ?? c.column_name) as string,
            type: (c.DATA_TYPE ?? c.data_type) as string,
          }));
          // Backtick the identifier so reserved words / case work.
          let sample: Record<string, unknown> | null = null;
          try {
            const [sampleRows] = await conn.query(`SELECT * FROM \`${tName}\` LIMIT 1`);
            sample = ((sampleRows as any[])[0] as Record<string, unknown>) ?? null;
          } catch { /* ignore */ }
          out.tables.push({ name: tName, columns: cols, sample });
        }
      } finally {
        try { await conn.end(); } catch { /* ignore */ }
      }
    } catch { /* swallow — empty inventory better than crash */ }
    return out;
  }

  // SQLite (or Excel-imported SQLite): walk PRAGMA table_info + sample row per
  // table. Excel imports are real SQLite files under var/tenants/ — same
  // introspection works.
  if (ds.kind === "sqlite" || ds.kind === "excel") {
    let db: any = null;
    try {
      db = openTenantSqlite(ds.tenantId ?? "", ds.connection);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 50")
        .all() as Array<{ name: string }>;
      for (const t of tables) {
        const cols = db.prepare(`PRAGMA table_info(${t.name})`).all() as Array<{ name: string; type: string }>;
        const sample = db.prepare(`SELECT * FROM ${t.name} LIMIT 1`).get() as Record<string, unknown> | undefined;
        out.tables.push({
          name: t.name,
          columns: cols.map((c) => ({ name: c.name, type: c.type })),
          sample: sample ?? null,
        });
      }
    } catch {
      /* swallow */
    } finally {
      if (db) try { db.close(); } catch { /* ignore */ }
    }
    return out;
  }

  // REST: read the discovered schema previously stored via /api/data-sources/[id]/probe
  // (or manual override). We synthesise a single "table" called the data
  // source name so the prompt looks identical to the SQLite path.
  if (ds.kind === "rest" && ds.discoveredSchemaJson) {
    try {
      const schema = JSON.parse(ds.discoveredSchemaJson) as {
        fields: Array<{ name: string; type: string }>;
        sampleRow: Record<string, unknown> | null;
        jsonPath?: string;
        probedFrom?: string;
      };
      out.tables.push({
        name: ds.name,
        columns: schema.fields.map((f) => ({ name: f.name, type: f.type })),
        sample: schema.sampleRow,
      });
    } catch { /* ignore corrupt schema */ }
  }

  // Lake: introspect LakeTable rows for the tenant carried in the
  // connection prefix. Without this branch, generate-from-prompt over
  // the Curf Tables source got an EMPTY tables list and the LLM
  // hallucinated table names + columns. Bug surfaced during pre-launch
  // QA (5/9/2026); fix is to walk Prisma's LakeTable model and project
  // schemaJson + a sample row for the same { name, columns, sample }
  // shape every other branch produces.
  if (ds.kind === "lake") {
    try {
      const tenantId = ds.connection.replace(/^lake:\/\//, "");
      out.engine = await tenantLakeEngine(tenantId);
      const { prisma } = await import("@/lib/db");
      const { canReadTable, previewRowsFor } = await import("@/lib/lake/readableRows");
      // The ACL isn't a column the query can filter on, so the cap of 50
      // applies after it: unreadable tables don't crowd out readable ones.
      const all = await prisma.lakeTable.findMany({
        where: { tenantId },
        select: { name: true, tenantId: true, ownerUserId: true, visibleToRolesJson: true, schemaJson: true },
      });
      const rows = all.filter((t) => canReadTable(t, viewer)).slice(0, 50);
      for (const r of rows) {
        let schema: Array<{ name: string; type: string }> = [];
        try {
          const parsed = JSON.parse(r.schemaJson || "[]");
          schema = (parsed as any[]).map((c) => ({ name: c.name, type: c.type ?? "text" }));
        } catch { /* skip malformed schema */ }
        let sample: Record<string, unknown> | null = null;
        try {
          const preview = (await previewRowsFor(r, viewer, 1)) ?? [];
          sample = (preview[0] as Record<string, unknown>) ?? null;
        } catch { /* ignore preview failure */ }
        out.tables.push({ name: r.name, columns: schema, sample });
      }
    } catch { /* swallow — empty inventory better than crash */ }
    return out;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------
