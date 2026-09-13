/**
 * POST /api/admin/connections
 *
 * Creates a SyncConnection + N SyncObjectMaps + one SyncJob in a single
 * transaction. Backs the /admin/connections/new wizard. Admin-only,
 * tenant-scoped.
 *
 * Body shape:
 *   {
 *     "name": "Production Postgres",
 *     "kind": "postgres" | "stripe",
 *     "config": {
 *       // postgres: { host, port?, database, user, password, schema?, ssl? }
 *       // stripe:   { apiKey }
 *     },
 *     "objects": [
 *       {
 *         "name": "customers",
 *         "targetTable": "pg_customers",
 *         "pkColumn": "id",
 *         "cursorColumn": "updated_at",
 *         "cursorKind": "timestamp",
 *         "schema": "public"
 *       }
 *     ],
 *     "scheduleCron": "0 * * * *"
 *   }
 *
 * Returns: { connectionId, jobId } — wizard redirects to
 * /admin/connections/[connectionId]/syncs.
 *
 * Credential encryption: postgres password and stripe apiKey are both
 * encrypted via lib/secrets.ts (AES-256-GCM). Plaintext never reaches
 * disk. The configJson stored on SyncConnection is JSON whose secret
 * fields are *Enc-suffixed ciphertext.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { encodePgConnection } from "@/lib/connections/postgres";
import { encryptSecret } from "@/lib/secrets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PostgresConfig = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().optional(),
  database: z.string().min(1),
  user: z.string().min(1),
  password: z.string().min(1),
  schema: z.string().optional(),
  ssl: z.boolean().optional(),
});

const StripeConfig = z.object({
  apiKey: z.string().min(20).startsWith("rk_").or(z.string().min(20).startsWith("sk_")),
});

const SalesforceConfig = z.object({
  instanceUrl: z.string().url(),
  clientId: z.string().min(10),
  clientSecret: z.string().min(10),
  accessToken: z.string().min(10),
  refreshToken: z.string().min(10),
  apiVersion: z.string().optional(),
});

// D3 — LINE has no "objects" concept (a single implicit stream of chat
// messages, not multiple source tables) and nothing to poll (Messaging API
// has no list-historical-messages endpoint), so it skips the
// objects/scheduleCron requirement entirely — see the .superRefine() below.
const LineConfig = z.object({
  channelAccessToken: z.string().min(10),
  channelSecret: z.string().min(10),
});

const ObjectSpec = z.object({
  name: z.string().min(1).max(120),
  targetTable: z.string().optional(),
  pkColumn: z.string().min(1).default("id"),
  cursorColumn: z.string().min(1),
  cursorKind: z.enum(["timestamp", "xmin", "id"]),
  schema: z.string().optional(),
});

const Body = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(["postgres", "stripe", "salesforce", "line"]),
  config: z.unknown(),
  objects: z.array(ObjectSpec).max(20).optional(),
  scheduleCron: z.string().min(5).max(120).optional(),
}).superRefine((data, ctx) => {
  if (data.kind === "line") return; // push-only source — no objects, no cron
  if (!data.objects || data.objects.length === 0) {
    ctx.addIssue({ code: "custom", path: ["objects"], message: "At least one object is required." });
  }
  if (!data.scheduleCron) {
    ctx.addIssue({ code: "custom", path: ["scheduleCron"], message: "A schedule is required." });
  }
});

export async function POST(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;

  const raw = await req.json().catch(() => null);
  if (!raw) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;

  // Per-kind config validation + encryption.
  let configJson: string;
  try {
    configJson = await encodeConfigJson(body.kind, body.config);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Invalid config" }, { status: 400 });
  }

  // Stripe enforces a fixed list of supported objects — reject anything
  // the connector won't know how to handle, rather than silently failing
  // later in the sync.
  if (body.kind === "stripe") {
    const allowed = new Set(["charges", "customers", "subscriptions", "invoices"]);
    const bad = body.objects!.filter((o) => !allowed.has(o.name));
    if (bad.length > 0) {
      return NextResponse.json({
        error: `Stripe connector supports only: ${[...allowed].join(", ")}. Got: ${bad.map((b) => b.name).join(", ")}`,
      }, { status: 400 });
    }
  }

  // Salesforce supports the four standard objects in this rollout;
  // custom objects ship in a later pass. Reject anything else clearly
  // rather than 401-ing during the first sync.
  if (body.kind === "salesforce") {
    const allowed = new Set(["Opportunity", "Account", "Lead", "User"]);
    const bad = body.objects!.filter((o) => !allowed.has(o.name));
    if (bad.length > 0) {
      return NextResponse.json({
        error: `Salesforce connector currently supports: ${[...allowed].join(", ")}. Got: ${bad.map((b) => b.name).join(", ")}`,
      }, { status: 400 });
    }
  }

  // Create everything in one round-trip. Prisma's interactive transactions
  // give us all-or-nothing — if the SyncJob create fails, the SyncConnection
  // gets rolled back, so we never leave half a sync wired up.
  const result = await prisma.$transaction(async (tx) => {
    const conn = await (tx as any).syncConnection.create({
      data: {
        tenantId: user.tenantId,
        kind: body.kind,
        name: body.name,
        configJson,
        enabled: true,
      },
    });

    // D3 — LINE has no SyncObjectMap/SyncJob: nothing to map (a single
    // implicit message stream) and nothing to cron-poll (push-only, see
    // lib/sync/connectors/line.ts's header comment).
    if (body.kind === "line") {
      return { conn, job: null };
    }

    for (const obj of body.objects!) {
      const targetTable = obj.targetTable ?? defaultTargetTable(body.kind, obj.name, obj.schema);
      await (tx as any).syncObjectMap.create({
        data: {
          connectionId: conn.id,
          sourceObject: obj.name,
          targetTable,
          columnMapJson: JSON.stringify({
            schema: obj.schema,
            pkColumn: obj.pkColumn,
            cursorColumn: obj.cursorColumn,
            cursorKind: obj.cursorKind,
            targetTable,
          }),
        },
      });
    }

    const job = await (tx as any).syncJob.create({
      data: {
        connectionId: conn.id,
        scheduleCron: body.scheduleCron!,
        objects: JSON.stringify(body.objects!.map((o) => o.name)),
        enabled: true,
        // First run is "right now" — the user almost always wants to
        // see data land in the lake before they leave the wizard,
        // rather than wait for the cron to roll around naturally.
        nextRunAt: new Date(),
      },
    });

    return { conn, job };
  });

  recordAudit({
    user,
    kind: "sync.connection.created",
    target: result.conn.id,
    req,
    meta: {
      kind: body.kind,
      name: body.name,
      objectCount: body.objects?.length ?? 0,
      schedule: body.scheduleCron ?? null,
    },
  });

  return NextResponse.json({
    ok: true,
    connectionId: result.conn.id,
    jobId: result.job?.id ?? null,
  });
}

// ---------------------------------------------------------------------------

async function encodeConfigJson(kind: string, config: unknown): Promise<string> {
  if (kind === "postgres") {
    const parsed = PostgresConfig.safeParse(config);
    if (!parsed.success) {
      throw new Error(
        "Postgres config requires host, database, user, password (port + schema + ssl optional)",
      );
    }
    // Reuse the same encrypted shape as live-SQL Postgres connections,
    // so a tenant can later share one credential between report-time
    // SQL and incremental sync.
    return encodePgConnection({
      host: parsed.data.host,
      port: parsed.data.port,
      database: parsed.data.database,
      user: parsed.data.user,
      password: parsed.data.password,
      schema: parsed.data.schema,
      ssl: parsed.data.ssl,
    });
  }
  if (kind === "stripe") {
    const parsed = StripeConfig.safeParse(config);
    if (!parsed.success) {
      throw new Error("Stripe config requires apiKey starting with rk_ or sk_");
    }
    const apiKeyEnc = encryptSecret(parsed.data.apiKey);
    return JSON.stringify({ apiKeyEnc });
  }
  if (kind === "salesforce") {
    const parsed = SalesforceConfig.safeParse(config);
    if (!parsed.success) {
      throw new Error(
        "Salesforce config requires instanceUrl (https), clientId, clientSecret, accessToken, refreshToken",
      );
    }
    // The Salesforce connector reads encrypted-auth-blob-inside-configJson —
    // clientId + instanceUrl stay plaintext (not secrets); clientSecret +
    // tokens get encrypted as a single blob so they rotate atomically when
    // the access token is refreshed.
    const authEnc = encryptSecret(JSON.stringify({
      clientSecret: parsed.data.clientSecret,
      refreshToken: parsed.data.refreshToken,
      accessToken: parsed.data.accessToken,
      // Conservative initial expiry — first 401 will refresh.
      accessTokenExpiresAt: new Date(Date.now() + 90 * 60_000).toISOString(),
    }));
    return JSON.stringify({
      apiVersion: parsed.data.apiVersion ?? "v60.0",
      instanceUrl: parsed.data.instanceUrl.replace(/\/+$/, ""),
      clientId: parsed.data.clientId,
      authEnc,
    });
  }
  if (kind === "line") {
    const parsed = LineConfig.safeParse(config);
    if (!parsed.success) {
      throw new Error("LINE config requires channelAccessToken and channelSecret");
    }
    return JSON.stringify({
      channelAccessTokenEnc: encryptSecret(parsed.data.channelAccessToken),
      channelSecretEnc: encryptSecret(parsed.data.channelSecret),
    });
  }
  throw new Error(`Unsupported kind: ${kind}`);
}

function defaultTargetTable(kind: string, objectName: string, schema?: string): string {
  if (kind === "postgres") {
    const safeSchema = (schema ?? "public").replace(/[^a-zA-Z0-9_]/g, "_");
    const safeObj = objectName.replace(/[^a-zA-Z0-9_]/g, "_");
    return `pg_${safeSchema}_${safeObj}`;
  }
  if (kind === "stripe") {
    return `stripe_${objectName.replace(/[^a-zA-Z0-9_]/g, "_")}`;
  }
  if (kind === "salesforce") {
    return `salesforce_${objectName.toLowerCase().replace(/[^a-zA-Z0-9_]/g, "_")}`;
  }
  return objectName.replace(/[^a-zA-Z0-9_]/g, "_");
}
