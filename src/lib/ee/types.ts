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
import type { ReactNode } from "react";
import type { DataSourceDef } from "@/lib/reporting/schema";
import type { Row } from "@/lib/reporting/interpolate";
import type { RunViewer } from "@/lib/reporting/runner";
import type { FiredItem } from "@/lib/cron/types";
import type {
  LakeColumn, LakeTableMeta, TypedConversionPreview, TypedConversionResult,
} from "@/lib/lake/tables";
import type { DateOrder } from "@/lib/lake/valueClean";
import type { StoredFormulas } from "@/lib/lake/formulaColumns";
import type { CurfSessionUser } from "@/lib/auth";
import type { NavCounts } from "@/lib/navCounts";

import type { Edition } from "./edition";
export type { Edition };

/** One table's shape as the report generator sees it. */
/** A read connection to a tenant's lake file, whichever engine holds it. */
export type LakeReadConnection = {
  all: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
  close: () => Promise<void>;
};

/** A tenant's live lake file: its user tables (no `__lake_*`), and a connection on demand. */
export type LakeFileReader = {
  listTables: () => Promise<string[]>;
  open: () => Promise<LakeReadConnection>;
};

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

/** A place a workspace keeps files on disk (lib/lifecycle/files.ts). */
export type FileTarget = { what: string; path: string; kind: "file" | "dir" };

/** The verdict of a Keycloak sign-in (src/ee/identity/signin.ts). */
export type IdentityDecision =
  | {
      ok: true; userId: string; email: string; tenantId: string; role: string; sid: string; acr: number;
      emailNewlyVerified: boolean; passwordCleared: boolean; linked: boolean; created: boolean; joinedTenantIds: string[];
    }
  | {
      ok: false;
      reason: "email_unverified" | "no_account" | "workspace_suspended" | "sso_required" | "mfa_required" | "identity_conflict" | "session_revoked"
        /** Came through a company IdP with an address its organisation has not verified, or through one that is not switched on. */
        | "sso_domain_mismatch" | "sso_not_enabled";
      userId?: string; tenantIds?: string[]; stepUp?: boolean; organizationId?: string;
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

  /**
   * What the paid lake (DuckDB, branches, Parquet copies, assets, streaming buffers, lineage) leaves behind, for the
   * customer lifecycle (lib/lifecycle/): the places it keeps a workspace's files, and a hook that makes this process let
   * go of the workspace before they are removed. `quiesce` returns the number of buffered rows it discarded.
   */
  lifecycle?: {
    fileTargets: (tenantId: string) => Promise<FileTarget[]>;
    quiesce: (tenantId: string) => Promise<number>;
  };

  /**
   * Enterprise identity (CURF_AUTH=keycloak, docs/KEYCLOAK_IDENTITY.md). Absent in the Community edition, and when Keycloak
   * isn't configured `enabled()` is false: sign-in is then NextAuth's credentials, Google and GitHub, as before.
   */
  identity?: {
    enabled: () => boolean;
    /** NextAuth providers to add (the Keycloak provider), or none. */
    providers: () => any[];
    /** Decide a Keycloak sign-in from the id_token claims. */
    signIn: (args: { profile: unknown; ip?: string | null; userAgent?: string | null }) => Promise<IdentityDecision>;
    /** Is this Keycloak-backed session still allowed (not revoked, idle or past its maximum age)? */
    checkSession: (sid: string, userId: string) => Promise<"ok" | "revoked" | "idle" | "expired">;
    /** End one session (own sign-out) or all of a person's. */
    revokeSessions: (by: { sid?: string; userId?: string }) => Promise<void>;
    /**
     * A local password sign-in while Keycloak is the sign-in: "ok" to proceed (the password is handed to Keycloak once, the
     * account migration window), or "use_identity_provider" when the person must use Keycloak instead (already migrated, window
     * over, or an organisation's SSO / MFA rule a password can't meet).
     */
    passwordSignIn: (user: { id: string; email: string; name: string | null; identityMigratedAt: Date | null }, password: string) => Promise<"ok" | "use_identity_provider">;
    /** Keycloak is the ONLY sign-in (CURF_AUTH_ONLY=1, or the password window is over): no password, Google or GitHub provider of Curf's own. */
    only: () => boolean;
    /** The social sign-ins Keycloak brokers for the login page, e.g. ["google", "github"]. */
    brokered: () => string[];
    /** Identity-first sign-in: the company IdP (Keycloak alias, used as `kc_idp_hint`) an email address belongs to, if its organisation has set one up and verified the domain. */
    companySignIn: (email: string) => Promise<{ alias: string } | null>;
    /**
     * Keycloak-only accounts: a person's password lives in Keycloak, Curf keeps an account row with no hash. `signUp` creates the
     * Keycloak user (with the password, held only for the call) and refuses an address Keycloak already has; `enrollInvitee` gives
     * an invited account its Keycloak user and mails the "confirm and choose a password" link; `mail` sends such a link to an existing
     * Keycloak user (forgot password, confirm the address).
     */
    accounts: {
      signUp: (input: { email: string; name?: string | null; password: string; emailVerified: boolean }) => Promise<{ ok: true; id: string } | { ok: false; reason: "exists" | "unavailable" | "password_policy" }>;
      /** Take back a Keycloak user created for a sign-up that then failed. */
      discard: (keycloakId: string) => Promise<void>;
      link: (userId: string, keycloakSub: string) => Promise<boolean>;
      enrollInvitee: (user: { id: string; email: string; name: string | null; emailVerifiedAt?: Date | null; keycloakSub?: string | null }, opts: { reason: string; mail?: boolean }) => Promise<{ mail: "sent" | "failed" | "not_needed"; linked: boolean }>;
      mail: (email: string, actions: Array<"VERIFY_EMAIL" | "UPDATE_PASSWORD">) => Promise<"sent" | "failed">;
    };
    /** The person's account is being erased: remove their Keycloak user too. */
    onUserErased: (user: { id: string; keycloakSub: string | null }) => Promise<void>;
    /** Where the browser goes to end the Keycloak session as well (RP-initiated logout). */
    endSessionUrl: (postLogoutRedirect: string) => string | null;
  };

  /** Embeddings behind "Find by meaning" and semantic search. */
  vectorStore?: {
    enqueueSchemaColEmbedBatch: (args: any) => Promise<unknown>;
    enqueueEmbedIfEnabled: (args: any) => Promise<unknown>;
    searchSimilar: (args: any) => Promise<Array<{ [k: string]: unknown }>>;
  };

  /** Semantic Metric Layer: enrich a dataset with governed metrics before render. */
  metrics?: {
    enrichDatasetWithMetrics: (dataset: any, report: any, tenantId: string, params: Record<string, unknown>, viewer: RunViewer) => Promise<void>;
    /** A metric's source and SQL, to gate a saved run's "metric:<slug>" rows. Absent → those rows are withheld. */
    getMetricGateSource: (tenantId: string, slug: string) => Promise<{ dataSourceId: string; sql: string } | null>;
    /**
     * The gate's governed-metrics hook: a KPI that names one of the workspace's
     * defined metrics is rewired to the metric's SQL (lib/metrics/govern.ts).
     * Returns the report to carry on with; absent in Community, which has no metrics.
     */
    /** The GOVERNED METRICS block of a planner / designer prompt for the metrics `texts` name ("" when none). */
    governedPrompt?: (tenantId: string, texts: string[], opts: { withSql: boolean }) => Promise<string>;
    governReport?: (report: any, args: { tenantId: string; viewer: RunViewer }) => Promise<{ report: any; substituted: Array<{ blockId: string; metricKey: string; before: number | null; after: number | null }> }>;
    /** The workspace's published metrics whose SQL names this lake table (the table page's "read by metrics" list). */
    readingTable?: (tenantId: string, tableName: string) => Promise<Array<{ slug: string; label: string }>>;
  };

  /** Data-quality checks (paid): the checks already defined on a lake table, for the table page's suggestions and delete warning. */
  dataQuality?: {
    tableChecks: (tenantId: string, tableName: string) => Promise<Array<{ kind: string; configJson: string }>>;
  };

  /** Analytic Apps: advance an app's data-mode badge after a table is bound to real rows. */
  apps?: {
    advanceAppDataModes: (tenantId: string, tableName: string) => Promise<string[]>;
  };

  /** My account (paid): the LINE and phone-notification cards, and the signed-in-devices list, on the console's /account. */
  account?: {
    notifyCards: (args: { tenantId: string; userId: string; lineResult?: string | null; lineBrief?: unknown }) => Promise<ReactNode>;
    /** "Where you're signed in" (a client component that hides itself when the person has no session records). */
    sessionsPanel: () => Promise<ReactNode>;
  };

  /** Off-site backup shipping (Business); DuckDB lake-engine reads (Team+). */
  /** Home (paid): the KPIs pinned to a person's Home. */
  home?: {
    /** Pin these report blocks after what the person has, skipping ones already pinned, never past the cap; how many were added. */
    addPins: (userId: string, tenantId: string, pins: Array<{ reportId: string; blockId: string }>) => Promise<number>;
    /** Note that this person opened a report or dashboard, for Home's "Pick up where you left off". Fire and forget, never fails the page. */
    noteView: (user: { id?: string; tenantId?: string; viaApiKey?: boolean } | null | undefined, kind: "report" | "dashboard" | "notebook", refId: string) => void;
  };

  /** Scheduled agent briefs (paid): the list on /schedules. */
  briefs?: {
    scheduledBriefs: () => Promise<ReactNode>;
  };
  lake?: {
    shipSnapshotToDestinations: (args: { tenantId: string; backupId: string; kind: string }) => Promise<unknown>;
    /**
     * For a tenant on a paid lake engine (DuckDB), read a lake table query
     * through that engine instead of the default per-tenant SQLite file.
     * `sql` uses `?` positional placeholders with `values` in order (same
     * convention as lib/lake's LakeConnection, not the report's own
     * `:name` syntax — the Community caller translates before calling this).
     * Returns null when the tenant is on the default engine (sqlite) or
     * doesn't have one set — the caller falls back to its own SQLite path,
     * since there's nothing paid to add for that tenant. (Cross-source
     * ATTACH is rejected upstream in runner.ts for any non-sqlite/excel
     * primary before this is ever called, so it's never asked to combine
     * ATTACH with a paid engine.)
     */
    readLakeIfPaidEngine: (tenantId: string, sql: string, values: unknown[]) => Promise<Row[] | null>;
    /**
     * Is this tenant's lake on a paid engine (DuckDB)? For code that only has
     * a question to ask of the default engine's storage — lib/lake/textNumbers.ts
     * checks SQLite's TEXT-stored number columns and has nothing to check on
     * DuckDB. Absent (Community): the default engine, always.
     */
    onPaidEngine: (tenantId: string) => Promise<boolean>;
    /**
     * For a tenant on a paid lake engine, create/replace a table there
     * instead of the default per-tenant SQLite file — same contract as
     * lib/lake/tables.ts's createOrReplaceTable. Returns null when the
     * tenant is on the default engine, so the caller falls back to its
     * own SQLite path.
     */
    createOrReplaceTableIfPaidEngine: (tenantId: string, opts: {
      tableName: string;
      rows: Array<Record<string, unknown>>;
      sourceKind: LakeTableMeta["sourceKind"];
      sourceConfig?: Record<string, unknown>;
      columnHints?: Record<string, string>;
      columnTypeOverrides?: Record<string, LakeColumn["type"]>;
      columnDateOrders?: Record<string, DateOrder>;
      /** See lib/lake/tables.ts's createOrReplaceTable — forces typed DDL
       *  for a derived-table (pipeline/MV) refresh regardless of the
       *  CURF_LAKE_TYPED_COLUMNS kill switch. */
      forceTypedColumns?: boolean;
      /** See lib/lake/tables.ts's createOrReplaceTable — the formula columns to declare. */
      formulas?: StoredFormulas;
    }) => Promise<{ columns: LakeColumn[]; rowCount: number; safeName: string; droppedFormulas?: Array<{ name: string; reason: string }> } | null>;
    /**
     * For a tenant on a paid lake engine, drop a table there instead of
     * the default per-tenant SQLite file. Returns false when the tenant
     * is on the default engine, so the caller falls back to its own
     * SQLite path; true means this handled the drop.
     */
    dropTableIfPaidEngine: (tenantId: string, tableName: string) => Promise<boolean>;
    /**
     * For a tenant on a paid lake engine, add a column there instead of
     * the default per-tenant SQLite file — same contract as
     * lib/lake/tables.ts's addColumn. Returns false when the tenant is on
     * the default engine, so the caller falls back to its own SQLite
     * path; true means this handled the ALTER TABLE.
     */
    addColumnIfPaidEngine: (tenantId: string, tableName: string, columnName: string, defaultValue?: string) => Promise<boolean>;
    /**
     * Same contract as addColumnIfPaidEngine, for lib/lake/tables.ts's
     * renameColumn: false = default engine (caller runs its own SQLite
     * path), true = handled. Also carries the column's stored date order
     * through the rename.
     */
    renameColumnIfPaidEngine: (tenantId: string, tableName: string, oldName: string, newName: string) => Promise<boolean>;
    /** Same contract, for lib/lake/tables.ts's dropColumn. */
    dropColumnIfPaidEngine: (tenantId: string, tableName: string, columnName: string) => Promise<boolean>;
    /**
     * For a tenant on a paid lake engine, add or change a formula column
     * there — same contract as lib/lake/tables.ts's setFormulaColumn.
     * DuckDB can only declare a generated column when it creates a table, so
     * this rebuilds the table with it. Returns null when the tenant is on
     * the default engine, so the caller runs its own SQLite path.
     */
    setFormulaColumnIfPaidEngine: (tenantId: string, opts: {
      tableName: string;
      columnName: string;
      formula: string;
      replace?: boolean;
    }) => Promise<{ type: import("@/lib/lake/formula/compile").FormulaType; uses: string[] } | null>;
    /**
     * For a tenant on a paid lake engine, retype a column there instead of
     * the default per-tenant SQLite file — same contract as
     * lib/lake/tables.ts's retypeColumn. Returns null when the tenant is
     * on the default engine, so the caller falls back to its own SQLite
     * path. Added for E1b Phase D2 (E1B_PHASE_D_SCOPING_PLAN.md) — Phase
     * D's date-column conversion relies on this function, since DuckDB's
     * own applyTypedConversionIfPaidEngine only handles number/boolean/
     * date-as-TIMESTAMP DDL rebuilds, not the "just clean the text"
     * in-place path this covers for whichever type predates typed columns.
     */
    retypeColumnIfPaidEngine: (tenantId: string, opts: {
      tableName: string;
      columnName: string;
      type: Exclude<LakeColumn["type"], "unknown">;
      dateOrder?: DateOrder;
    }) => Promise<{ updated: number; unchanged: number } | null>;
    /**
     * For a tenant on a paid lake engine, preview an existing-table typed-
     * column conversion there instead of the default per-tenant SQLite
     * file — same contract as lib/lake/tables.ts's previewTypedConversion
     * (E1B_PHASE_D_SCOPING_PLAN.md, D1/D2). Returns null when the tenant
     * is on the default engine, so the caller falls back to its own
     * SQLite path. Read-only — safe regardless of typedColumnsEnabled().
     */
    previewTypedConversionIfPaidEngine: (tenantId: string, opts: {
      tableName: string;
    }) => Promise<TypedConversionPreview | null>;
    /**
     * For a tenant on a paid lake engine, apply an existing-table typed-
     * column conversion there instead of the default per-tenant SQLite
     * file — same contract as lib/lake/tables.ts's applyTypedConversion
     * (E1B_PHASE_D_SCOPING_PLAN.md, D1/D2). Returns null when the tenant
     * is on the default engine, so the caller falls back to its own
     * SQLite path. Real DDL rewriting real existing rows — gated behind
     * typedColumnsEnabled() the same way the SQLite path is.
     */
    applyTypedConversionIfPaidEngine: (tenantId: string, opts: {
      tableName: string;
      columns?: string[];
      expectedLossy?: Record<string, number>;
    }) => Promise<TypedConversionResult | null>;
    /**
     * Run `fn` (an existing-table typed conversion) only when it can't be
     * silently undone: no open lake branch on the tenant (a later branch
     * merge swaps the whole lake file and would revert it) and no other
     * conversion already running. Rejects with a TypedConversionBlockedError
     * otherwise, and fails closed if the branch lookup itself errors.
     * (E1B_PHASE_D_SCOPING_PLAN.md D3.) Absent in the Community edition,
     * where branches don't exist — the caller just runs `fn` directly.
     */
    withTypedConversionGuard: <T>(tenantId: string, fn: () => Promise<T>) => Promise<T>;
    /**
     * Run `fn` — a swap that replaces the tenant's live lake file itself
     * (mergeBranch, restoreBackup) — while holding that file's per-file lock
     * when the tenant is on a paid lake engine: it starts once every in-flight
     * operation on the file has finished and holds new ones off until it
     * returns. Without that, a POSIX rename lets an operation in flight carry
     * on against the old, now-unlinked file (its writes silently lost), and a
     * DuckDB open landing between restoreBackup's unlink and rename creates a
     * fresh empty database at the live path. Runs `fn` unwrapped on the
     * default engine. Not re-entrant: `fn` must not open the tenant's lake
     * file through the engine. Absent in the Community edition — the caller
     * just runs `fn`.
     */
    withLiveLakeFileLock: <T>(tenantId: string, fn: () => Promise<T>) => Promise<T>;
    /**
     * For a tenant on a paid lake engine, write a batch of single-column
     * per-row updates there instead of the default per-tenant SQLite
     * file — used by master-builder/migrate.ts's post-ALTER backfill
     * step, where the `rowid` values come from a prior
     * readLakeIfPaidEngine SELECT against the same table. Returns false
     * when the tenant is on the default engine, so the caller falls back
     * to its own SQLite transaction.
     */
    backfillColumnIfPaidEngine: (
      tenantId: string, tableName: string, columnName: string, updates: Array<{ rowid: number; value: string | null }>,
    ) => Promise<boolean>;
    /**
     * For a tenant on a paid lake engine, append rows there instead of the
     * default per-tenant SQLite file — same full contract as
     * lib/lake/tables.ts's appendRows, including creating the table on
     * first write. Returns null when the tenant is on the default engine,
     * so the caller falls back to its own SQLite path.
     */
    appendRowsIfPaidEngine: (tenantId: string, opts: {
      tableName: string;
      rows: Array<Record<string, unknown>>;
      columns?: import("@/lib/lake/tables").LakeColumn[];
    }) => Promise<{ added: number; newColumns: string[] } | null>;
    /**
     * For a tenant on a paid lake engine, upsert rows by key there instead
     * of the default per-tenant SQLite file — same contract as
     * lib/lake/tables.ts's upsertLakeRowsByKey. Returns null when the
     * tenant is on the default engine, so the caller falls back to its
     * own SQLite path.
     */
    upsertLakeRowsByKeyIfPaidEngine: (tenantId: string, opts: {
      tableName: string;
      keyColumn: string;
      rows: Array<Record<string, unknown>>;
      sourceKind?: LakeTableMeta["sourceKind"];
      sourceConfig?: Record<string, unknown>;
    }) => Promise<{ upserted: number; newColumns: string[] } | null>;
    /**
     * For a tenant on a paid lake engine, read a table's meta there
     * instead of the default per-tenant SQLite file — same contract as
     * lib/lake/tables.ts's getTable. Returns `undefined` when the tenant
     * is on the default engine, so the caller falls back to its own
     * SQLite path — distinct from `null`, which means "on a paid engine,
     * but this table doesn't exist there" (a legitimate getTable result).
     */
    getTableIfPaidEngine: (tenantId: string, tableName: string) => Promise<LakeTableMeta | null | undefined>;
    /**
     * For a tenant on a paid lake engine, preview rows there instead of
     * the default per-tenant SQLite file — same contract as
     * lib/lake/tables.ts's previewRows. Returns `undefined` when the
     * tenant is on the default engine, so the caller falls back to its
     * own SQLite path.
     */
    previewRowsIfPaidEngine: (tenantId: string, tableName: string, limit?: number, offset?: number) => Promise<any[] | undefined>;
    /**
     * For a tenant on a paid lake engine, count rows there instead of the
     * default per-tenant SQLite file — same contract as
     * lib/lake/tables.ts's rowCount. Returns `undefined` when the tenant
     * is on the default engine, so the caller falls back to its own
     * SQLite path.
     */
    rowCountIfPaidEngine: (tenantId: string, tableName: string) => Promise<number | undefined>;
    /**
     * For a tenant on a paid lake engine, read a column's distinct values
     * there instead of the default per-tenant SQLite file — same contract
     * as lib/lake/tables.ts's distinctColumnValues. Returns `undefined`
     * when the tenant is on the default engine, so the caller falls back
     * to its own SQLite path.
     */
    distinctColumnValuesIfPaidEngine: (tenantId: string, tableName: string, columnName: string, limit?: number) => Promise<string[] | undefined>;
    /**
     * For a tenant on a paid lake engine, the path to their live lake
     * file and whether it exists yet — used by backup/branch creation's
     * upfront "is there anything to snapshot/branch" check and to know
     * where a restore/merge should rename onto. Returns `undefined` when
     * the tenant is on the default engine, so the caller resolves its
     * own SQLite path (lib/lake/storage.ts's tenantLakePath) instead.
     */
    paidLiveLakeFile: (tenantId: string) => Promise<{ path: string; exists: boolean } | undefined>;
    /**
     * For a tenant on a paid lake engine, a reader over their live lake file
     * (its tables, and a connection opened on demand) — used by
     * lib/lake/catalogReconcile.ts after a restore/merge swaps the file.
     * `undefined` on the default engine: the caller reads its SQLite file.
     */
    liveLakeReaderIfPaidEngine: (tenantId: string) => Promise<LakeFileReader | undefined>;
    /**
     * For a tenant on a paid lake engine, clone their live lake file to
     * `destPath` — used by backup/branch creation instead of SQLite's
     * VACUUM INTO. Returns `undefined` when the tenant is on the default
     * engine, so the caller does its own VACUUM INTO as before.
     */
    cloneLakeFileIfPaidEngine: (tenantId: string, destPath: string) => Promise<{ sizeBytes: number } | undefined>;
    /**
     * For a tenant on a paid lake engine, count the rows in an arbitrary
     * file's __lake_meta table (i.e. how many lake tables it holds) —
     * used by backup.ts's snapshotTenant for the UI's "N tables" count.
     * Returns `undefined` when the tenant is on the default engine.
     */
    countTablesInFileIfPaidEngine: (tenantId: string, filePath: string) => Promise<number | undefined>;
    /**
     * For a tenant on a paid lake engine, integrity-check an arbitrary
     * file already known to be in that engine's format (a staged restore
     * file) — used by backup.ts's restoreBackup instead of SQLite's
     * `PRAGMA integrity_check`. Returns `undefined` when the tenant is on
     * the default engine, so the caller runs its own check — distinct
     * from `null`, which means "checked, no corruption found" (mirrors
     * LakeEngine.integrityCheck's own null-means-ok contract).
     */
    integrityCheckIfPaidEngineFile: (tenantId: string, filePath: string) => Promise<string | null | undefined>;
    /**
     * For a tenant on a paid lake engine, read one table + its origin
     * meta out of an arbitrary snapshot file (already gunzipped to
     * `filePath`) — used by backup.ts's restoreTableFromBackup. Returns
     * `undefined` when the tenant is on the default engine, so the
     * caller opens the file as SQLite itself. Throws (doesn't return
     * undefined) when the table isn't present in the snapshot, mirroring
     * the SQLite path's own thrown error for that case.
     */
    readTableFromSnapshotIfPaidEngine: (tenantId: string, filePath: string, tableName: string) => Promise<{
      rows: any[];
      sourceKind: LakeTableMeta["sourceKind"];
      sourceConfig: Record<string, unknown>;
    } | undefined>;
    /**
     * For a tenant on a paid lake engine, paginated table read + row
     * count out of an arbitrary snapshot file — used by
     * lib/lake/timeTravel.ts's readTableAsOf. Returns `undefined` when
     * the tenant is on the default engine, so the caller opens the file
     * as SQLite itself — distinct from `null`, which means "checked, the
     * table isn't in this snapshot" (a legitimate readTableAsOf result).
     */
    readTableAsOfFromSnapshotIfPaidEngine: (
      tenantId: string, filePath: string, tableName: string, limit: number, offset: number,
    ) => Promise<{ rows: any[]; rowCount: number } | null | undefined>;
    /**
     * Register the streaming-ingest buffer's flush-on-shutdown hook
     * (E2_JOBS_SCOPING_PLAN.md Phase B) — called once from
     * src/instrumentation.ts's register() at process boot. Streaming push
     * (lib/lake/streamIngest.ts) is Business+ only and excluded from the
     * Community export entirely, so instrumentation.ts (Community-shipped)
     * can't import it directly — this indirection is the only reason this
     * member exists; it isn't a per-tenant lake operation like everything
     * else in this block. Absent in Community, where there's no streaming
     * buffer to flush.
     */
    registerStreamIngestShutdownFlush: () => Promise<void>;
  };

  /** Invite-only signup gate (Cloud private beta). Absent = open signup. */
  signupGate?: {
    verifyInviteToken: (token: string) => Promise<{ id: string; email: string; workspaceName: string | null } | null>;
  };

  /** Seat billing (Stripe). Community routes call this after a membership
   *  change; absent in the Community edition, where nothing is billed. */
  billing?: {
    syncSeats: (tenantId: string) => Promise<unknown>;
  };

  /** Curf's own operators (roadmap page). */
  operator?: {
    roadmapMismatchCount: () => number;
  };

  /** Lineage graph (paid — excluded from Community). Community's Tables
   *  pages call this defensively for the "used in N reports" badge and
   *  detail-page list; absent means the badge/section just doesn't render. */
  lineage?: {
    usedInReports: (tenantId: string, lakeTableId: string) => Promise<Array<{ id: string; label: string }>>;
  };

  /** The nav badges of paid surfaces (notebooks, Operate, decisions,
   *  metrics, watchers, data quality, Deep Ask). GET /api/nav/counts adds
   *  them to the Community ones; absent in Community, whose nav has none of
   *  those items. */
  navCounts?: {
    paid: (user: CurfSessionUser) => Promise<NavCounts>;
  };
};
