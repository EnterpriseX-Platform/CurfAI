/**
 * The Community / paid boundary — server side.
 *
 * Community code never imports a paid module directly. Where a Community
 * surface has a paid extension point (a warehouse connector, a cron tick,
 * an embedding hook), it reaches through `ee` from "@/ee", typed here.
 * The private repo's `src/ee/index.ts` fills every member in; the public
 * export replaces that file with a stub that fills none (see
 * scripts/community-export/root/src/ee/index.ts), so every member is
 * optional and every call site must cope with it being absent.
 *
 * Rules:
 *   - This file may import types from Community modules only.
 *   - Members are plain data or functions; nothing runs at import time.
 *   - A missing member means "not in this edition", never an error.
 */
import type { NextRequest, NextResponse } from "next/server";
import type { DataSourceDef } from "@/lib/reporting/schema";
import type { Row } from "@/lib/reporting/interpolate";
import type { FiredItem } from "@/lib/cron/types";

import type { Edition } from "./edition";
export type { Edition };

/** One table's shape as the report generator sees it. */
export type IntrospectedTable = {
  name: string;
  columns: Array<{ name: string; type: string }>;
  sample: Record<string, unknown> | null;
};

/**
 * A query connector that is not in Community (Snowflake, BigQuery). The
 * report runner, the data-source API and the report generator each call
 * one method; the connector owns credentials, drivers and SQL dialect.
 */
export type WarehouseConnector = {
  /** Run one report query and return rows. Mirrors the Community drivers' signature. */
  run: (ds: DataSourceDef, dsRow: { connection: string }, cache: Map<string, any>, params: Record<string, unknown>) => Promise<Row[]>;
  /** Encode a create payload into the stored (encrypted) connection string. */
  encode: (input: any) => string;
  /** Merge a partial update over the stored connection and re-encode it. */
  encodeUpdate: (patch: any, existing: string) => string;
  /** Redact a stored connection for the client. */
  mask: (connection: string) => Record<string, unknown>;
  /** Table names for the inventory endpoint; best-effort, empty on failure. */
  listTables: (connection: string, limit: number) => Promise<string[]>;
  /** Tables with columns and one sample row, for report generation. */
  introspect: (connection: string) => Promise<IntrospectedTable[]>;
  /** `POST /api/data-sources/[id]` with `{ test: <kind> }` — the connection test. */
  test: (req: NextRequest) => Promise<NextResponse>;
};

export type EeRegistry = {
  edition: Edition;

  connectors?: {
    /** Keyed by DataSource.kind. */
    warehouses: Record<string, WarehouseConnector>;
    /** SFTP (Growth): encode/mask for the data-source API, fetch for scheduled pulls. */
    sftp?: {
      encode: (input: any) => string;
      encodeUpdate: (patch: any, existing: string) => string;
      mask: (connection: string) => Record<string, unknown>;
      fetchRows: (connection: string) => Promise<Row[]>;
      test: (req: NextRequest) => Promise<NextResponse>;
    };
    /** Guided REST presets (HubSpot, Zendesk): preset payload → base URL + auth headers. */
    restPreset?: (preset: { kind: string; [k: string]: unknown }) => { baseUrl: string; headers: Record<string, string>; presetKind: string } | null;
  };

  cron?: {
    /**
     * Schedules of a paid kind ("watcher", "brief", "digest"). Returns null
     * for a kind this edition doesn't know, so the tick can record it.
     */
    fireSchedule: (sched: any, req: NextRequest) => Promise<{ status: string; narrative?: string } | null>;
    /** Paid ticks, run after the Community ones. Returns extra fields for the tick's JSON body. */
    tick: (ctx: { req: NextRequest; fired: FiredItem[]; now: Date; force: boolean }) => Promise<Record<string, unknown>>;
    /** Route a security alert into Operate (the security-alert tick). */
    fireSecurityAlert?: (args: { tenantId: string; userEmail: string; failedCount: number; windowMinutes: number }) => Promise<void>;
  };

  /** Embeddings behind "Find by meaning" and semantic search. */
  vectorStore?: {
    enqueueSchemaColEmbedBatch: (args: any) => Promise<unknown>;
    enqueueEmbedIfEnabled: (args: any) => Promise<unknown>;
    searchSimilar: (args: any) => Promise<Array<{ [k: string]: unknown }>>;
  };

  /** Semantic Metric Layer: enrich a dataset with governed metrics before render. */
  metrics?: {
    enrichDatasetWithMetrics: (dataset: any, report: any, tenantId: string, params: Record<string, unknown>) => Promise<void>;
  };

  /** Analytic Apps: advance an app's data-mode badge after a table is bound to real rows. */
  apps?: {
    advanceAppDataModes: (tenantId: string, tableName: string) => Promise<string[]>;
  };

  /** Off-site backup shipping (Business). */
  lake?: {
    shipSnapshotToDestinations: (args: { tenantId: string; backupId: string; kind: string }) => Promise<unknown>;
  };

  /** Invite-only signup gate (Cloud private beta). Absent = open signup. */
  signupGate?: {
    verifyInviteToken: (token: string) => Promise<{ id: string; email: string; workspaceName: string | null } | null>;
  };

  /** Curf's own operators (roadmap page). */
  operator?: {
    roadmapMismatchCount: () => number;
  };
};
