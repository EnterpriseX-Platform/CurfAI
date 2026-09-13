import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ee } from "@/ee";
import { paidConnector, unsupportedKindResponse } from "@/lib/connections/paid";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin, tenantWhere, getUserRoles } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { writeVisibility, canSeeDataSource, type Visibility } from "@/lib/datasourceAcl";
import { encodeRestConnection } from "@/lib/connections/rest";
import { encodePgConnection } from "@/lib/connections/postgres";
import { encodeMyConnection } from "@/lib/connections/mysql";
import { featureGate, type FeatureKey } from "@/lib/featureGate";

// HubSpot/Zendesk are guided presets over the "rest" kind, not their own
// DataSource.kind — see lib/connections/hubspot.ts's header comment. This
// resolves a preset input into the {baseUrl, headers, presetKind} shape
// encodeRestConnection() expects; returns null when no preset was given
// (the ordinary raw baseUrl+headers path, unchanged).
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

// Map a connector kind to its tier-gating FeatureKey. Free kinds (sqlite,
// rest, excel) aren't in the map — `?? null` lets POST skip the gate for
// them without a separate branch.
const CONNECTOR_FEATURE: Record<string, FeatureKey> = {
  postgres:  "connector.postgres",
  mysql:     "connector.mysql",
  snowflake: "connector.snowflake",
  bigquery:  "connector.bigquery",
  sftp:      "connector.sftp",
};

// Visibility is shared across kinds — every connection (REST, SQLite, Excel)
// can opt into the same three modes. Default mode is "tenant" which preserves
// the original "everyone in the tenant can see it" behaviour.
const VisibilityInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("tenant") }),
  z.object({ mode: z.literal("roles"), roles: z.array(z.string().min(1)).min(1) }),
  z.object({ mode: z.literal("owner_only") }),
]).optional();

const DataSourceInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sqlite"),
    name: z.string().min(1),
    connection: z.string().min(1),
    visibility: VisibilityInputSchema,
  }),
  z.object({
    kind: z.literal("rest"),
    name: z.string().min(1),
    // Required unless `preset` is given — the preset resolver computes
    // baseUrl (and headers) server-side instead.
    baseUrl: z.string().url().optional(),
    headers: z.record(z.string()).optional(),
    visibility: VisibilityInputSchema,
    // Only meaningful for REST — SQL-kind sources are already unconditionally
    // SELECT-only (assertSelectOnly), so the flag isn't offered on them.
    readOnly: z.boolean().optional(),
    // Guided HubSpot/Zendesk setup — see resolveRestPreset() above. When
    // present, overrides baseUrl/headers entirely. One of baseUrl/preset is
    // required — checked in the handler (z.discriminatedUnion members must
    // stay plain ZodObjects, not ZodEffects, so this isn't a .refine() here).
    preset: RestPresetInputSchema,
  }),
  z.object({
    kind: z.literal("postgres"),
    name: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().positive().optional(),
    database: z.string().min(1),
    user: z.string().min(1),
    password: z.string().min(1),
    schema: z.string().optional(),
    ssl: z.boolean().optional(),
    visibility: VisibilityInputSchema,
  }),
  z.object({
    kind: z.literal("mysql"),
    name: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().positive().optional(),
    database: z.string().min(1),
    user: z.string().min(1),
    password: z.string().min(1),
    ssl: z.boolean().optional(),
    visibility: VisibilityInputSchema,
  }),
  z.object({
    kind: z.literal("snowflake"),
    name: z.string().min(1),
    account: z.string().min(1),
    username: z.string().min(1),
    password: z.string().min(1),
    warehouse: z.string().min(1),
    database: z.string().min(1),
    schema: z.string().optional(),
    role: z.string().optional(),
    visibility: VisibilityInputSchema,
  }),
  z.object({
    kind: z.literal("bigquery"),
    name: z.string().min(1),
    projectId: z.string().min(1),
    dataset: z.string().min(1),
    location: z.string().optional(),
    /** Full service-account JSON pasted from the .json key file. */
    credentialsJson: z.string().min(1),
    visibility: VisibilityInputSchema,
  }),
  // SFTP — feeds only the scheduled lake-ingestion pull (lib/lake/restPull.ts),
  // never a live report query. remotePath names the single file a LakePull
  // downloads.
  z.object({
    kind: z.literal("sftp"),
    name: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().positive().optional(),
    username: z.string().min(1),
    authMethod: z.enum(["password", "privateKey"]),
    password: z.string().min(1).optional(),
    privateKey: z.string().min(1).optional(),
    passphrase: z.string().optional(),
    remotePath: z.string().min(1),
    visibility: VisibilityInputSchema,
  }),
]);

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rowsAll = await prisma.dataSource.findMany({
    where: tenantWhere(user),
    orderBy: { createdAt: "desc" },
    select: {
      id: true, name: true, kind: true, connection: true, discoveredSchemaJson: true, createdAt: true,
      visibleToRolesJson: true, ownerUserId: true, readOnly: true,
    },
  });

  // Apply visibility ACL. Admins bypass role-scoped restrictions but NOT
  // owner_only — "Just me" really means just that user. canSeeDataSource()
  // encodes that asymmetry.
  const userRoles = await getUserRoles();
  const isAdmin = user.role === "admin";
  const rows = rowsAll.filter((r: any) =>
    canSeeDataSource(r, { id: user.id, isAdmin, roles: userRoles }),
  );

  // Resolve visibility once per row, then attach to the wire shape. The
  // client uses this for the visibility chip + admin edit dialog.
  // Capture `user` into a non-null local so TS can prove it's defined inside
  // the inner closure (the early return at the top of the handler narrows it
  // here, but the narrowing doesn't survive crossing a function boundary).
  const currentUser = user;
  function visibilityFor(r: any) {
    if (r.ownerUserId) {
      return { mode: "owner_only", ownerUserId: r.ownerUserId, isOwner: r.ownerUserId === currentUser.id };
    }
    let roles: string[] = [];
    try {
      const parsed = JSON.parse(r.visibleToRolesJson ?? "[]");
      if (Array.isArray(parsed)) roles = parsed.filter((s: any) => typeof s === "string");
    } catch { /* corrupt → tenant */ }
    return roles.length > 0 ? { mode: "roles", roles } : { mode: "tenant" };
  }

  return NextResponse.json({
    items: rows.map((r: any) => {
      const visibility = visibilityFor(r);
      if (r.kind === "rest") {
        try {
          const parsed = JSON.parse(r.connection) as { baseUrl?: string; presetKind?: "hubspot" | "zendesk" };
          return { id: r.id, name: r.name, kind: r.kind, baseUrl: parsed.baseUrl, presetKind: parsed.presetKind, createdAt: r.createdAt, visibility, readOnly: r.readOnly };
        } catch {
          return { id: r.id, name: r.name, kind: r.kind, createdAt: r.createdAt, visibility, readOnly: r.readOnly };
        }
      }
      if (r.kind === "postgres") {
        try {
          const parsed = JSON.parse(r.connection) as { host?: string; port?: number; database?: string; ssl?: boolean };
          const endpoint = `${parsed.host ?? "?"}:${parsed.port ?? 5432}/${parsed.database ?? "?"}` + (parsed.ssl ? " (ssl)" : "");
          return { id: r.id, name: r.name, kind: r.kind, baseUrl: endpoint, createdAt: r.createdAt, visibility };
        } catch {
          return { id: r.id, name: r.name, kind: r.kind, createdAt: r.createdAt, visibility };
        }
      }
      if (r.kind === "mysql") {
        try {
          const parsed = JSON.parse(r.connection) as { host?: string; port?: number; database?: string; ssl?: boolean };
          const endpoint = `${parsed.host ?? "?"}:${parsed.port ?? 3306}/${parsed.database ?? "?"}` + (parsed.ssl ? " (ssl)" : "");
          return { id: r.id, name: r.name, kind: r.kind, baseUrl: endpoint, createdAt: r.createdAt, visibility };
        } catch {
          return { id: r.id, name: r.name, kind: r.kind, createdAt: r.createdAt, visibility };
        }
      }
      if (r.kind === "snowflake") {
        try {
          const parsed = JSON.parse(r.connection) as { account?: string; database?: string; schema?: string; warehouse?: string };
          // account → DB.SCHEMA — keep it readable in one row.
          const endpoint = `${parsed.account ?? "?"} → ${parsed.database ?? "?"}.${parsed.schema ?? "PUBLIC"}` + (parsed.warehouse ? ` (wh ${parsed.warehouse})` : "");
          return { id: r.id, name: r.name, kind: r.kind, baseUrl: endpoint, createdAt: r.createdAt, visibility };
        } catch {
          return { id: r.id, name: r.name, kind: r.kind, createdAt: r.createdAt, visibility };
        }
      }
      if (r.kind === "bigquery") {
        try {
          const parsed = JSON.parse(r.connection) as { projectId?: string; dataset?: string; location?: string };
          // project.dataset is the natural BigQuery address — show location
          // when set since multi-region matters for cost/locality.
          const endpoint = `${parsed.projectId ?? "?"}.${parsed.dataset ?? "?"}` + (parsed.location ? ` (${parsed.location})` : "");
          return { id: r.id, name: r.name, kind: r.kind, baseUrl: endpoint, createdAt: r.createdAt, visibility };
        } catch {
          return { id: r.id, name: r.name, kind: r.kind, createdAt: r.createdAt, visibility };
        }
      }
      if (r.kind === "sftp") {
        try {
          const parsed = JSON.parse(r.connection) as { host?: string; port?: number; remotePath?: string };
          const endpoint = `${parsed.host ?? "?"}:${parsed.port ?? 22}${parsed.remotePath ?? ""}`;
          return { id: r.id, name: r.name, kind: r.kind, baseUrl: endpoint, createdAt: r.createdAt, visibility };
        } catch {
          return { id: r.id, name: r.name, kind: r.kind, createdAt: r.createdAt, visibility };
        }
      }
      if (r.kind === "excel") {
        // Surface the originally-uploaded filename and table/row counts so
        // the connections list can show something more useful than the raw
        // .db path. The actual file path is intentionally NOT echoed back.
        try {
          const schema = JSON.parse(r.discoveredSchemaJson ?? "{}") as {
            originalFilename?: string;
            tables?: Array<{ rowCount: number }>;
            importedAt?: string;
          };
          const tableCount = schema.tables?.length ?? 0;
          const rowCount = schema.tables?.reduce((s, t) => s + (t.rowCount ?? 0), 0) ?? 0;
          return {
            id: r.id, name: r.name, kind: r.kind, createdAt: r.createdAt, visibility,
            originalFilename: schema.originalFilename,
            importedAt: schema.importedAt,
            tableCount, rowCount,
          };
        } catch {
          return { id: r.id, name: r.name, kind: r.kind, createdAt: r.createdAt, visibility };
        }
      }
      return { id: r.id, name: r.name, kind: r.kind, createdAt: r.createdAt, visibility };
    }),
  });
}

export async function POST(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const body = await req.json().catch(() => null);
  const parsed = DataSourceInputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid", issues: parsed.error.issues }, { status: 400 });
  if (parsed.data.kind === "rest" && !parsed.data.baseUrl && !parsed.data.preset) {
    return NextResponse.json({ error: "Invalid", issues: [{ path: ["baseUrl"], message: "baseUrl or preset is required" }] }, { status: 400 });
  }

  // Feature gate by connector kind. Free kinds (sqlite/rest/excel) skip the
  // check; warehouses (Postgres/MySQL → Team, Snowflake/BigQuery → Business)
  // 402 with the FEATURE_TIERS mapping. We gate AFTER schema validation so
  // the error body is consistent with other 402 callers (currentTier +
  // requiredTier + upgradeUrl).
  const featureKey = CONNECTOR_FEATURE[parsed.data.kind];
  if (featureKey) {
    const blocked = await featureGate(user, featureKey);
    if (blocked) return blocked;
  }

  if ((parsed.data.kind === "snowflake" || parsed.data.kind === "bigquery" || parsed.data.kind === "sftp") && !paidConnector(parsed.data.kind)) {
    return unsupportedKindResponse(parsed.data.kind);
  }
  const restPreset = parsed.data.kind === "rest" ? resolveRestPreset(parsed.data.preset) : null;
  const connection = parsed.data.kind === "rest"
    ? encodeRestConnection(
        restPreset
          ? { baseUrl: restPreset.baseUrl, headers: restPreset.headers, presetKind: restPreset.presetKind }
          : { baseUrl: parsed.data.baseUrl!, headers: parsed.data.headers ?? {} },
      )
    : parsed.data.kind === "postgres"
      ? encodePgConnection({
          host: parsed.data.host,
          port: parsed.data.port,
          database: parsed.data.database,
          user: parsed.data.user,
          password: parsed.data.password,
          schema: parsed.data.schema,
          ssl: parsed.data.ssl,
        })
      : parsed.data.kind === "mysql"
        ? encodeMyConnection({
            host: parsed.data.host,
            port: parsed.data.port,
            database: parsed.data.database,
            user: parsed.data.user,
            password: parsed.data.password,
            ssl: parsed.data.ssl,
          })
        : parsed.data.kind === "snowflake" || parsed.data.kind === "bigquery" || parsed.data.kind === "sftp"
          ? paidConnector(parsed.data.kind)!.encode(parsed.data)
          : parsed.data.connection;

  // Resolve visibility into the persisted columns. owner_only is bound to the
  // CURRENT user — clients can't pick a different owner via the API.
  const vIn = parsed.data.visibility;
  const visibility: Visibility = !vIn || vIn.mode === "tenant"
    ? { mode: "tenant" }
    : vIn.mode === "owner_only"
      ? { mode: "owner_only", ownerUserId: user.id }
      : { mode: "roles", roles: vIn.roles };
  const aclColumns = writeVisibility(visibility);

  try {
    const created = await prisma.dataSource.create({
      data: {
        tenantId: user.tenantId,
        name: parsed.data.name,
        kind: parsed.data.kind,
        connection,
        visibleToRolesJson: aclColumns.visibleToRolesJson,
        ownerUserId: aclColumns.ownerUserId,
        readOnly: parsed.data.kind === "rest" ? (parsed.data.readOnly ?? false) : false,
      },
    });
    recordAudit({
      user, kind: "datasource.create", target: created.id, req,
      meta: {
        name: parsed.data.name,
        kind: parsed.data.kind,
        visibility: visibility.mode,
        visibleToRoles: visibility.mode === "roles" ? visibility.roles : undefined,
      },
    });
    return NextResponse.json({ id: created.id, name: created.name, kind: created.kind });
  } catch (e: any) {
    if (e?.code === "P2002") {
      const dup = 'A connection named "' + parsed.data.name + '" already exists. Pick a different name or delete the existing one.';
      return NextResponse.json({ error: dup }, { status: 409 });
    }
    return NextResponse.json({ error: e?.message ?? "Failed to create connection" }, { status: 500 });
  }
}
