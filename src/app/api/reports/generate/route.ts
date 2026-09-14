import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ReportSchema } from "@/lib/reporting/schema";
import { requireUser, requireAdminOrEditor, tenantWhere, getUserRoles, blockScopedApiKey } from "@/lib/auth";
import { canSeeDataSource } from "@/lib/datasourceAcl";
import { withTenantContext } from "@/lib/rls";
import { recordAudit } from "@/lib/audit";
import { ensureLimit } from "@/lib/rateLimit";
import { requireReportQuota } from "@/lib/billing";
import { requireAiCreditsFor } from "@/lib/llm";
import { callLLM } from "@/lib/llm";
import { ee } from "@/ee";
import Database from "better-sqlite3";

/**
 * POST /api/reports/generate
 *
 * Natural-language report generation. The user types what they want, the
 * server discovers what data they have, and the configured LLM returns a
 * ReportSchema JSON instance which we validate, persist, and redirect to.
 *
 * Pipeline:
 *   1. Auth + report quota gate (Free plan caps at 5 reports).
 *   2. Pull the user's DataSource rows for this tenant.
 *   3. For SQLite kind: introspect each table (PRAGMA table_info + sample row).
 *   4. Build a system prompt teaching the model:
 *        - The ReportSchema JSON shape it must return
 *        - The available block types + chart types + parameter types
 *        - The user's actual tables + columns + sample rows
 *   5. Send the user's prompt + system prompt via the unified LLM
 *      entrypoint — provider-agnostic (Anthropic / OpenAI / Gemini /
 *      OpenAI-compatible).
 *   6. Extract the first JSON code block from the response.
 *   7. Validate with ReportSchema.safeParse(); on failure, return 422 with
 *      the issues so the user (or a follow-up call) can refine.
 *   8. Persist + redirect to the new report viewer.
 *
 * Falls back gracefully if no LLM provider is configured.
 */

const Schema = z.object({
  prompt: z.string().min(8).max(2000),
  /** Optional: scope generation to one connection. Defaults to first available. */
  dataSourceId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const user = await requireAdminOrEditor(req);
  if (user instanceof NextResponse) return user;
  // No existing report id to check against — this introspects every tenant
  // data source (including sample rows) to build the prompt, well beyond
  // anything a report-scoped key should be able to reach.
  const scopeBlock = blockScopedApiKey(user);
  if (scopeBlock) return scopeBlock;

  const limited = ensureLimit("generate", `t:${user.tenantId}`, 10, 60_000);
  if (limited) return limited;

  const block = await requireReportQuota(user);
  if (block) return block;

  // AI credits (lib/billing.ts). callLLM meters every call on Curf's key
  // anyway; checking here too keeps the 402 cheap and ahead of the schema
  // parser. Gated AFTER the report quota so a Free user at the report cap
  // learns the more salient limit first.
  const creditsBlock = await requireAiCreditsFor(user.tenantId);
  if (creditsBlock) return creditsBlock;

  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid prompt", issues: parsed.error.issues }, { status: 400 });
  }

  // Pull this tenant's data sources, then filter by what THIS user can see —
  // private uploads ("Just me") and role-scoped sources are dropped before
  // they reach the prompt.
  const allDataSources = await prisma.dataSource.findMany({
    where: tenantWhere(user),
    select: {
      id: true, name: true, kind: true, connection: true, discoveredSchemaJson: true,
      visibleToRolesJson: true, ownerUserId: true,
    },
  });
  const userRoles = await getUserRoles();
  const isAdmin = (user as any).role === "admin";
  const dataSources = allDataSources.filter((d: any) =>
    canSeeDataSource(d, { id: user.id, isAdmin, roles: userRoles }),
  );
  if (dataSources.length === 0) {
    return NextResponse.json({
      error: "No data sources you can use are connected. Add a connection first under Data → Connections.",
    }, { status: 400 });
  }
  // Prefer a file- or db-backed source (SQLite, Excel-imported SQLite, or
  // Postgres) by default since they're always introspectable; a REST source
  // only contributes if it has a probed schema.
  const targetDs = parsed.data.dataSourceId
    ? dataSources.find((d: any) => d.id === parsed.data.dataSourceId) ?? dataSources[0]
    : (dataSources.find((d: any) => d.kind === "lake" || d.kind === "sqlite" || d.kind === "excel" || d.kind === "postgres" || d.kind === "mysql" || d.kind === "snowflake" || d.kind === "bigquery") ?? dataSources[0]);

  // Introspect tables. SQLite/Excel: better-sqlite3 + PRAGMA. Postgres:
  // information_schema.{tables,columns}. Cap at 50 tables either way.
  const introspection = await introspectTables(targetDs);

  // Cross-source ATTACH: when the primary is file-backed AND the user has
  // OTHER file-backed sources visible, surface them to Claude as candidates
  // for ATTACH. We cap each at 5 tables to keep prompt size bounded.
  const attachableInputs =
    (introspection.kind === "sqlite" || introspection.kind === "excel")
      ? dataSources.filter((d: any) =>
          d.id !== targetDs.id && (d.kind === "sqlite" || d.kind === "excel"))
      : [];
  const attachables = await Promise.all(attachableInputs.map(async (d: any) => {
    const intro = await introspectTables(d);
    return {
      dataSourceId: d.id,
      dataSourceName: intro.dataSourceName,
      kind: intro.kind,
      // Trim tables to a small sample so the prompt doesn't explode when
      // there are many file-backed sources in the workspace.
      tables: intro.tables.slice(0, 5),
    };
  }));

  // Tier 2 cross-source: joinable sources of ANY kind. When the primary is
  // file-backed, ATTACH (Tier 1) is preferred — but joinables are still
  // surfaced for cases where the user wants to merge a Postgres or REST
  // source. When the primary is Postgres, joinables are the only option.
  // When the primary is REST, neither attaches nor joins make sense
  // (REST has no static schema; multi-query merging is fragile).
  const joinableInputs = (introspection.kind === "rest")
    ? []
    : dataSources.filter((d: any) => d.id !== targetDs.id);
  const joinables = await Promise.all(joinableInputs.map(async (d: any) => {
    const intro = await introspectTables(d);
    return {
      dataSourceId: d.id,
      dataSourceName: intro.dataSourceName,
      kind: intro.kind,
      tables: intro.tables.slice(0, 5),
    };
  }));

  const systemPrompt = buildSystemPrompt(introspection, attachables, joinables);

  const llmResult = await callLLM({
    tenantId: user.tenantId,
    kind: "generate",
    userId: user.id,
    system: systemPrompt,
    messages: [{ role: "user", content: parsed.data.prompt }],
    maxTokens: 4000,
    responseFormat: "json",
  });
  if (llmResult.status === "failed") {
    return NextResponse.json({ error: llmResult.error || "AI request failed." }, { status: 500 });
  }

  // Pull the JSON out of the LLM response and validate.
  const reportJson = extractJson(llmResult.text);
  if (!reportJson) {
    return NextResponse.json({
      error: "AI returned no parseable JSON. Try a more specific prompt.",
      raw: llmResult.text.slice(0, 500),
    }, { status: 422 });
  }

  // Stamp the dataSourceId onto every generated query so the runner can
  // resolve them. Claude only knows the *name* of the data source, not its
  // database row id.
  if (Array.isArray(reportJson.dataSources)) {
    for (const ds of reportJson.dataSources) {
      ds.dataSourceId = targetDs.id;
      // The kind on DataSourceDef should match the connection kind.
      if (!ds.kind) ds.kind = targetDs.kind;
    }
  }
  // Default any missing required ReportSchema fields.
  reportJson.version = reportJson.version ?? 1;
  reportJson.parameters = reportJson.parameters ?? [];
  reportJson.dataSources = reportJson.dataSources ?? [];
  reportJson.pages = reportJson.pages ?? [{ id: "p1", size: "A4", orientation: "portrait", blocks: [] }];

  const validated = ReportSchema.safeParse(reportJson);
  if (!validated.success) {
    return NextResponse.json({
      error: "Generated report failed validation",
      issues: validated.error.issues.slice(0, 10),
      raw: JSON.stringify(reportJson).slice(0, 1000),
    }, { status: 422 });
  }

  const def = validated.data;

  const created = await withTenantContext(user, (tx) =>
    tx.report.create({
      data: {
        tenantId: user.tenantId,
        name: def.name,
        description: def.description ?? null,
        category: def.category ?? null,
        definition: JSON.stringify(def),
        createdById: user.id,
      },
    }),
  );

  recordAudit({
    user, kind: "report.generate", target: created.id, req,
    meta: {
      prompt: parsed.data.prompt.slice(0, 200),
      blockCount: def.pages.reduce((s, p) => s + p.blocks.length, 0),
      queryCount: def.dataSources.length,
    },
  });

  return NextResponse.json({ id: created.id, name: created.name });
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

type TableSchema = {
  name: string;
  columns: Array<{ name: string; type: string }>;
  sample: Record<string, unknown> | null;
};

export async function introspectTables(ds: { id: string; name: string; kind: string; connection: string; discoveredSchemaJson?: string | null }): Promise<{
  dataSourceName: string;
  kind: string;
  tables: TableSchema[];
}> {
  const out: { dataSourceName: string; kind: string; tables: TableSchema[] } = {
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
      db = new Database(ds.connection, { readonly: true, fileMustExist: true });
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
      const { prisma } = await import("@/lib/db");
      const { previewRows } = await import("@/lib/lake/tables");
      const rows = await prisma.lakeTable.findMany({
        where: { tenantId },
        select: { name: true, schemaJson: true },
        take: 50,
      });
      for (const r of rows ?? []) {
        let schema: Array<{ name: string; type: string }> = [];
        try {
          const parsed = JSON.parse(r.schemaJson || "[]");
          schema = (parsed as any[]).map((c) => ({ name: c.name, type: c.type ?? "text" }));
        } catch { /* skip malformed schema */ }
        let sample: Record<string, unknown> | null = null;
        try {
          const preview = previewRows(tenantId, r.name, 1);
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

function buildSystemPrompt(
  intro: { dataSourceName: string; kind: string; tables: TableSchema[] },
  attachables: Array<{ dataSourceId: string; dataSourceName: string; kind: string; tables: TableSchema[] }> = [],
  joinables: Array<{ dataSourceId: string; dataSourceName: string; kind: string; tables: TableSchema[] }> = [],
): string {
  const schemaBlock = intro.tables
    .map((t) => {
      const colList = t.columns.map((c) => `${c.name} ${c.type || "?"}`).join(", ");
      const sample = t.sample ? "  sample: " + JSON.stringify(t.sample) : "";
      return `- ${t.name}(${colList})${sample ? "\n" + sample : ""}`;
    })
    .join("\n");

  // Kind-specific data-source guidance. The runner can execute SQL against
  // SQLite, Excel-imported SQLite, Postgres, and MySQL connections; REST
  // connections need method/path/jsonPath instead. Each SQL kind shares the
  // :name parameter syntax but has different date/string built-ins — see
  // DIALECT below.
  const isRest = intro.kind === "rest";
  const isPostgres = intro.kind === "postgres";
  const isMysql = intro.kind === "mysql";
  const isSnowflake = intro.kind === "snowflake";
  const isBigQuery = intro.kind === "bigquery";
  const fileBacked = intro.kind === "sqlite" || intro.kind === "excel";
  const hasAttachables = fileBacked && attachables.length > 0;
  const dataSourceShape = isRest
    ? '  "dataSources": [{ "id": "ds_xxx", "name": "Friendly name", "kind": "rest", "method": "GET", "path": "/v3.1/all?fields=name,population,area,region,cca3", "jsonPath": "$" }],'
    : isPostgres
      ? '  "dataSources": [{ "id": "ds_xxx", "name": "Friendly name", "kind": "postgres", "sql": "SELECT ..." }],'
      : isMysql
        ? '  "dataSources": [{ "id": "ds_xxx", "name": "Friendly name", "kind": "mysql", "sql": "SELECT ..." }],'
        : isSnowflake
          ? '  "dataSources": [{ "id": "ds_xxx", "name": "Friendly name", "kind": "snowflake", "sql": "SELECT ..." }],'
          : isBigQuery
            ? '  "dataSources": [{ "id": "ds_xxx", "name": "Friendly name", "kind": "bigquery", "sql": "SELECT ..." }],'
            : hasAttachables
              ? '  "dataSources": [{ "id": "ds_xxx", "name": "Friendly name", "kind": "sqlite", "sql": "SELECT ... FROM main.t1 JOIN m.t2 ON ...", "attaches": [{ "dataSourceId": "<foreign id>", "alias": "m" }] }],'
              : '  "dataSources": [{ "id": "ds_xxx", "name": "Friendly name", "kind": "sqlite", "sql": "SELECT ..." }],';

  const queryGuidance = isRest
    ? [
        "QUERY DESIGN GUIDANCE (REST data source):",
        "- This connection is a REST API. DO NOT write SQL. Each query must use { kind:'rest', method, path, jsonPath }.",
        "- `path` is appended to the connection's baseUrl. Use :name tokens to bind parameters into the URL (e.g. /v3.1/region/:region_filter).",
        "- `jsonPath` plucks the rows array out of the response (use \"$\" for top-level array, or \"$.results\", \"$.data.items\", etc.).",
        "- The fields above describe one row of the response. Reference them by name in block configs.",
        "- Since REST APIs typically return raw rows (not aggregates), do client-side aggregation: KPI blocks set `aggregate: 'sum'|'avg'|'count'`, chart blocks set `orderBy` + `limit`. The platform will compute the metric from the raw rows.",
        "- Do not GROUP BY or write WHERE clauses — these are SQL-only. Filter by passing parameters into the path or by relying on the API's own query string.",
        "- Each block can reuse the same query — point queryId at one shared dataSource entry rather than re-fetching for every block.",
      ].join("\n")
    : [
        `QUERY DESIGN GUIDANCE (${isPostgres ? "Postgres" : isMysql ? "MySQL" : isSnowflake ? "Snowflake" : isBigQuery ? "BigQuery" : "SQLite"} data source):`,
        "- Each chart/KPI/table block needs its own query in dataSources[].",
        "- Keep query ids short and snake_case (ds_kpi_total, ds_by_channel, ...).",
        "- For aggregates, prefer GROUP BY + ORDER BY rather than client-side magic.",
        "- For KPI queries, return a single row; the valueField names the column.",
        "- For sparklines, return a time-bucketed series (week/month) ordered ASC.",
        "- For pivots, return one row per (rowField, colField) pair plus a numeric value column.",
        "- For maps, return one row per region with the region key (ISO-3 country code or 2-letter US state code).",
        isPostgres
          ? "- Reference parameters with :name placeholders. Curf translates :name to $1 for Postgres automatically — same SQL works on both kinds."
          : isMysql
            ? "- Reference parameters with :name placeholders. Curf translates :name to ? positional binds for MySQL automatically — same SQL works on every kind."
            : isSnowflake
              ? "- Reference parameters with :name placeholders. Curf translates :name to ? positional binds for Snowflake automatically — same SQL works on every kind."
              : isBigQuery
                ? "- Reference parameters with :name placeholders. Curf translates :name to BigQuery's native @name binding — same SQL works on every kind."
                : "- Reference parameters with :name placeholders. Curf binds them as named parameters on SQLite.",
        "",
        "SQL DIALECT:",
        ...(isPostgres ? [
          "- This is POSTGRES. DO NOT use SQLite-only built-ins (strftime, date('now'), datetime()) — they don't exist.",
          "- Date bucketing: use to_char(col, 'YYYY-MM') or date_trunc('month', col). For week: date_trunc('week', col).",
          "- Current time: NOW() or CURRENT_TIMESTAMP. Date math: col - INTERVAL '7 days'.",
          "- String concat: col1 || col2 (works on both) or CONCAT(col1, col2).",
          "- Casts: ::numeric, ::date, ::text — Postgres-specific shorthand. CAST(x AS y) also works.",
          "- Quote identifiers with double quotes when they contain capitals or reserved words: \"MyTable\".",
          "- LIMIT works the same way; OFFSET is also supported.",
        ] : isBigQuery ? [
          "- This is BIGQUERY (Standard SQL). Identifiers must use the fully-qualified `project.dataset.table` form, quoted with backticks: SELECT id, total FROM `myproj.analytics.orders`.",
          "- The data inventory above is for one specific dataset; reference its tables as `<project>.<dataset>.<table>`. The project and dataset are implicit in the connection — you can omit the project for tables in the same project, but the dataset prefix is REQUIRED.",
          "- Date bucketing: DATE_TRUNC(col, MONTH) for month, DATE_TRUNC(col, WEEK) for week. FORMAT_DATE('%Y-%m', col) is a string-friendly alternative.",
          "- Current time: CURRENT_TIMESTAMP() / CURRENT_DATE(). Date math: DATE_SUB(col, INTERVAL 7 DAY) or col - INTERVAL 7 DAY (latter only on TIMESTAMP/DATETIME).",
          "- String concat: CONCAT(a, b). The `||` operator is SAFE_OR on BigQuery — do NOT use it for concat.",
          "- Casts: CAST(x AS INT64), CAST(x AS DATE), CAST(x AS STRING). Also SAFE_CAST(x AS INT64) which returns NULL on parse failures.",
          "- Backticks for identifiers ALWAYS when they contain dashes/dots: `my-project.dataset.tab` — and around reserved words.",
          "- LIMIT n; OFFSET m supported. QUALIFY can replace HAVING for window-function filters.",
          "- BigQuery bills by bytes scanned — keep aggregates server-side and avoid SELECT * on wide tables. Use partition / cluster columns in WHERE when possible.",
        ] : isSnowflake ? [
          "- This is SNOWFLAKE (ANSI SQL with Snowflake extensions). Identifiers are UPPERCASE by default — table and column names returned by INFORMATION_SCHEMA are uppercase, so you can write them unquoted in UPPERCASE: SELECT ID, NAME FROM ORDERS.",
          "- Quote identifiers with double quotes when you need lowercase or mixed-case: SELECT \"id\", \"customerName\" FROM \"Orders\". The schema and table you connect to are also stored uppercase.",
          "- Date bucketing: DATE_TRUNC('MONTH', col) for month, DATE_TRUNC('WEEK', col) for week. TO_CHAR(col, 'YYYY-MM') also works.",
          "- Current time: CURRENT_TIMESTAMP() or CURRENT_DATE(). Date math: DATEADD(day, -7, col) or col - INTERVAL '7 days'.",
          "- String concat: CONCAT(a, b) or a || b — both supported.",
          "- Casts: CAST(x AS NUMBER), TRY_CAST(x AS DATE), or shorthand x::NUMBER, x::DATE. Snowflake supports the Postgres-style ::cast syntax.",
          "- LIMIT n; OFFSET m supported. QUALIFY can replace HAVING for window functions.",
          "- Snowflake bills compute by warehouse-second — keep aggregates server-side and trim wide SELECT * scans on big tables.",
        ] : isMysql ? [
          "- This is MYSQL. DO NOT use SQLite-only built-ins (strftime, date('now'), datetime()) and DO NOT use Postgres-only built-ins (to_char, date_trunc, ::cast) — they don't exist on MySQL.",
          "- Date bucketing: DATE_FORMAT(col, '%Y-%m') for month, DATE_FORMAT(col, '%x-W%v') or YEARWEEK(col) for week. Day: DATE(col).",
          "- Current time: NOW() or CURRENT_TIMESTAMP. Date math: col - INTERVAL 7 DAY.",
          "- String concat: CONCAT(col1, col2). The `||` operator is logical OR on MySQL by default — do NOT use it for concat.",
          "- Casts: CAST(x AS DECIMAL), CAST(x AS DATE), CAST(x AS CHAR). No Postgres-style ::shorthand.",
          "- Quote identifiers with backticks when they contain reserved words or capitals: `MyTable`.`my column`.",
          "- LIMIT n OFFSET m or LIMIT m, n. Avoid SELECT FOR UPDATE — Curf opens read-only sessions.",
        ] : [
          "- This is SQLITE. Date bucketing: strftime('%Y-%m', col) for month, strftime('%Y-W%W', col) for week.",
          "- Current time: date('now') / datetime('now'). Date math: date(col, '-7 days').",
          "- String concat: col1 || col2.",
          "- No native casting syntax beyond CAST(x AS y); SQLite is dynamically typed.",
        ]),
        ...(hasAttachables ? [
          "",
          "CROSS-SOURCE ATTACH (Tier 1 — SQLite + Excel-imported sources):",
          "- The primary connection above is the default schema (`main`).",
          "- Other sqlite/excel connections in this workspace can be ATTACHed onto the same query so SQL can JOIN across them.",
          "- To do this, set `attaches: [{ dataSourceId: '<id>', alias: '<short>' }]` on the query, then reference foreign tables as `<alias>.<table>` in the SQL.",
          "- Use this ONLY when a single block genuinely needs data from multiple sources — typically: enriching warehouse rows with an uploaded spreadsheet, or comparing counts/totals across sources via UNION ALL.",
          "- For independent blocks (KPI from warehouse, table from Excel) prefer separate dataSources entries — simpler, faster, and clearer to the reader.",
          "- Aliases must be SQL identifiers and not 'main' or 'temp'. Pick something short like `m`, `kpi`, `ext`.",
          "- REST and Postgres connections cannot be ATTACHed; for those use cross-kind joins[] (Tier 2) instead.",
        ] : []),
        ...(joinables.length > 0 ? [
          "",
          "CROSS-KIND JOINS (Tier 2 — any source kind):",
          "- When you need to merge data from sources of DIFFERENT kinds (e.g. Postgres orders + Excel campaigns, or a REST endpoint + a SQLite warehouse), emit two separate dataSources entries (one per source) AND a third entry that uses `joins[]` to merge them.",
          "- Shape: { id: 'ds_merged', name: '...', dataSourceId: '<primary id>', sql: 'SELECT ...', joins: [{ type: 'left'|'inner', queryId: '<sibling query id>', on: { left: 'col_in_primary', right: 'col_in_sibling' }, alias: 'c' }] }",
          "- The sibling query must exist in the SAME dataSources[] array; queryId references that entry's `id`. The runner topo-sorts and runs the sibling first.",
          "- Output rows have primary columns plus prefixed sibling columns: `{ id, customer_id, amount, c__id, c__name, c__region }`. Block configs can reference either set.",
          "- Pick join keys that genuinely correspond — usually a foreign-key relationship like primary.customer_id = sibling.id.",
          "- Use joins[] ONLY when a single block needs merged columns. For independent blocks across sources, use separate dataSources entries (no joins[]) — simpler, faster.",
          "- Aliases follow the same rules as attaches[] aliases.",
        ] : []),
      ].join("\n");

  const attachablesBlock = hasAttachables
    ? attachables.map((a) => {
        const lines = a.tables.map((t) => {
          const cols = t.columns.map((c) => `${c.name} ${c.type || "?"}`).join(", ");
          return `  - ${t.name}(${cols})`;
        }).join("\n");
        return [
          `Source "${a.dataSourceName}" (${a.kind}, dataSourceId="${a.dataSourceId}")`,
          lines || "  (no tables discovered)",
        ].join("\n");
      }).join("\n\n")
    : "";

  return [
    "You are Curf, an AI report designer. The user describes what they want to see; you produce a complete, valid Curf report definition as JSON.",
    "",
    "OUTPUT REQUIREMENTS:",
    "- Return ONE JSON object inside a single ```json code block. Nothing else.",
    "- The JSON MUST validate against the Curf ReportSchema (described below).",
    "- Do not invent tables or columns — use only what the data inventory below lists.",
    isRest
      ? "- THIS CONNECTION IS REST. Do NOT write SQL. Use method/path/jsonPath on every dataSource entry. Aggregations happen client-side (aggregate, orderBy, limit on the block)."
      : isPostgres
        ? "- THIS CONNECTION IS POSTGRES. Use Postgres-compatible SQL with named :parameters (Curf translates them to $1). See SQL DIALECT below — strftime/date('now') don't exist; use to_char/date_trunc/NOW()."
        : isMysql
          ? "- THIS CONNECTION IS MYSQL. Use MySQL-compatible SQL with named :parameters (Curf translates them to ? positional binds). See SQL DIALECT below — strftime, to_char, date_trunc, and ::casts don't exist; use DATE_FORMAT, CAST(x AS y), backticks for identifiers, CONCAT() not ||."
          : isSnowflake
            ? "- THIS CONNECTION IS SNOWFLAKE. Use Snowflake-flavoured ANSI SQL with named :parameters (Curf translates them to ? positional binds). Identifiers are UPPERCASE — write `SELECT ID FROM ORDERS`, not `select id from orders`. See SQL DIALECT below for date/time helpers."
            : isBigQuery
              ? "- THIS CONNECTION IS BIGQUERY. Use BigQuery Standard SQL with named :parameters (Curf translates them to BigQuery's @name binding). ALWAYS qualify tables with their dataset prefix and wrap in backticks: `project.dataset.table`. See SQL DIALECT below — DATE_TRUNC takes a part keyword (MONTH, WEEK), || is logical OR not concat (use CONCAT)."
              : "- Use SQLite-compatible SQL with named :parameters where filters are useful.",
    "",
    "REPORTSCHEMA SHAPE:",
    "{",
    '  "version": 1,',
    '  "name": "<short title for this report>",',
    '  "description": "<one sentence>",',
    '  "category": "<one of: Marketing | Sales | Finance | Operations | HR | Custom>",',
    '  "parameters": [{ "name": "...", "label": "...", "type": "string|number|date|dateRange|boolean|select", "default": "...", "options": [{"value":"x","label":"X"}] }],',
    dataSourceShape,
    '  "pages": [{ "id": "p1", "size": "A4", "orientation": "portrait", "blocks": [...blocks] }]',
    "}",
    "",
    "BLOCK TYPES (each block has id, x, y, w, h on a 12-column grid + type-specific config):",
    "- title:   { type:'title',   config:{ text: '...', subtitle: '...?' } }",
    "- text:    { type:'text',    config:{ markdown: '...' } }",
    "- kpi:     { type:'kpi',     config:{ queryId, label, valueField, format:'number|currency|percent', aggregate?:'sum|avg|count|min|max', sparkQueryId?, sparkValueField? } }",
    "- chart:   { type:'chart',   config:{ queryId, chartType:'bar|line|area|pie|donut|combo|treemap|funnel|scatter', xField, yFields:[...], stacked?, showLegend?, showDataLabels?, valueFormat?, lineFields?, sizeField?, orderBy?, orderDirection?:'asc|desc', limit?, drilldown?:{queryId,filterParam} } }",
    "- table:   { type:'table',   config:{ queryId, columns:[{ key, label, type?:'string|number|currency|percent|date|datetime', align?:'left|center|right', total?:'none|sum|avg|count|min|max' }] } }  // NOTE: column field is named 'key', not 'field'.",
    "- pivot:   { type:'pivot',   config:{ queryId, rowField, colField, valueField, aggregation:'sum|avg|count|min|max', format?, heatmap?:true } }",
    "- heatmap: { type:'heatmap', config:{ queryId, mode:'calendar|grid', dateField?(calendar), xField?(grid), yField?(grid), valueField, aggregation, ramp?:'primary|emerald|amber|rose|cyan' } }",
    "- map:     { type:'map',     config:{ queryId, regionType:'country|us-state', regionField, valueField, aggregation, format? } }",
    "- callout: { type:'callout', config:{ variant:'info|success|warning|danger', title, body } }",
    "- progress, image, divider, pageBreak — supported, see Curf docs",
    "",
    "LAYOUT GUIDANCE (12-column grid, taller numbers = lower on page):",
    "- Title block at the top: x=0 y=0 w=12 h=2",
    "- Row of 3 KPIs:        x=0 y=2 w=4 h=3, x=4 y=2 w=4 h=3, x=8 y=2 w=4 h=3",
    "- Hero chart full-width: x=0 y=5 w=12 h=6",
    "- Side-by-side charts:   x=0 y=11 w=6 h=5, x=6 y=11 w=6 h=5",
    "- Heatmap or pivot:      x=0 y=16 w=12 h=5",
    "- Table at the bottom:   x=0 y=21 w=12 h=8",
    "",
    "DATA INVENTORY (data source: " + intro.dataSourceName + ", kind: " + intro.kind + "):",
    schemaBlock || "(no schema discovered yet)",
    ...(hasAttachables ? [
      "",
      "AVAILABLE FOR ATTACH (other file-backed sources you may JOIN against; reference via the alias):",
      attachablesBlock,
    ] : []),
    ...(joinables.length > 0 ? [
      "",
      "AVAILABLE FOR CROSS-KIND JOIN (any kind — surface them via joins[] when you need columns from multiple sources in one block):",
      joinables.map((j) => {
        const lines = j.tables.map((t) => {
          const cols = t.columns.map((c) => `${c.name} ${c.type || "?"}`).join(", ");
          return `  - ${t.name}(${cols})`;
        }).join("\n");
        return `Source "${j.dataSourceName}" (${j.kind}, dataSourceId="${j.dataSourceId}")\n${lines || "  (no tables discovered)"}`;
      }).join("\n\n"),
    ] : []),
    "",
    queryGuidance,
    "",
    "STYLE: pick a sensible name, write a one-sentence description, choose 3-6 charts/blocks total. Don't pad with empty blocks.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// (LLM call moved to lib/llm — handled inline via callLLM())
// ---------------------------------------------------------------------------

/** Pull the first JSON object out of a markdown-fenced reply. */
function extractJson(text: string): any | null {
  // Try fenced ```json ... ``` first (the format we asked for).
  const fence = /```json\s*([\s\S]+?)```/i.exec(text);
  const candidate = fence ? fence[1] : firstJsonObject(text);
  if (!candidate) return null;
  try { return JSON.parse(candidate); } catch { return null; }
}

function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
