/**
 * Shared wire types for the connection-editing UI. Used by both the
 * full-page Connections manager (app/(main)/connections) and the Report
 * Builder's Data drawer (components/designer/DataDrawer).
 */
import type { FeatureKey } from "@/lib/featureGate";

export type DataSourceKind = "sqlite" | "rest" | "excel" | "postgres" | "mysql" | "snowflake" | "bigquery" | "sftp";

/**
 * ConnectionForm's kind-picker state. "hubspot"/"zendesk" are guided
 * presets, never a real persisted DataSource.kind (that's always "rest" for
 * them — see lib/connections/hubspot.ts's header comment) — this widens
 * only the FORM's local state, not the wire type above, so a value coming
 * back from the server is always a real DataSourceKind.
 */
export type PickerKind = DataSourceKind | "hubspot" | "zendesk";

// Map a connector kind to its FeatureKey so the picker can decide whether
// to show the form fields or an UpgradeLock card. Free kinds aren't in the
// map — the helpers below treat "no entry" as "always available".
export const KIND_FEATURE: Partial<Record<DataSourceKind, FeatureKey>> = {
  postgres:  "connector.postgres",
  mysql:     "connector.mysql",
  snowflake: "connector.snowflake",
  bigquery:  "connector.bigquery",
  sftp:      "connector.sftp",
};

/**
 * Wire-format for visibility, mirroring lib/datasourceAcl.ts:
 *   - tenant     → everyone in the workspace
 *   - roles      → only users with at least one matching role
 *   - owner_only → only the uploader (no admin override)
 */
export type VisibilityWire =
  | { mode: "tenant" }
  | { mode: "roles"; roles: string[] }
  | { mode: "owner_only"; ownerUserId?: string; isOwner?: boolean };

/** Masked Postgres details for the edit form. Password is never echoed. */
export type PgDetails = {
  host: string;
  port: number;
  database: string;
  user: string;
  schema: string;
  ssl: boolean;
  hasPassword: boolean;
};

/**
 * Masked MySQL details for the edit form. Same shape as Postgres minus the
 * `schema` field — MySQL uses the database itself as the schema namespace.
 */
export type MyDetails = {
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: boolean;
  hasPassword: boolean;
};

/**
 * Masked Snowflake details for the edit form. Snowflake's connection model
 * adds account locator + warehouse + role on top of the usual
 * username/database/schema fields.
 */
export type SfDetails = {
  account: string;
  username: string;
  warehouse: string;
  database: string;
  schema: string;
  role: string | null;
  hasPassword: boolean;
};

/**
 * Masked BigQuery details for the edit form. The whole service-account JSON
 * is the secret here — `clientEmail` is surfaced separately so we can label
 * "Connected as <bot>@<project>.iam.gserviceaccount.com" without leaking
 * the private key.
 */
export type BqDetails = {
  projectId: string;
  dataset: string;
  location: string | null;
  clientEmail: string;
  hasCredentials: boolean;
};

/**
 * Masked SFTP details for the edit form. Neither secret (password / private
 * key) is ever echoed — only whether one is set, same convention as
 * PgDetails.hasPassword.
 */
export type SftpDetails = {
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "privateKey";
  remotePath: string;
  hasPassword: boolean;
  hasPrivateKey: boolean;
};

export type DataSourceListItem = {
  id: string;
  name: string;
  kind: DataSourceKind;
  baseUrl?: string;
  /** Excel-only: surfaced from discoveredSchemaJson by the GET /api/data-sources route. */
  originalFilename?: string;
  tableCount?: number;
  rowCount?: number;
  visibility?: VisibilityWire;
  /** REST only — see DataSource.readOnly's doc comment in schema.prisma. */
  readOnly?: boolean;
  /** REST only — set when this connection was created via a guided preset. */
  presetKind?: "hubspot" | "zendesk";
};

export type EditingConnection = {
  id: string;
  name: string;
  kind: DataSourceKind;
  baseUrl?: string;
  /** REST only: header NAMES the server has stored — values never round-trip to the client. */
  headerKeys?: string[];
  hasHeaders?: boolean;
  connection?: string;
  pg?: PgDetails;
  my?: MyDetails;
  sf?: SfDetails;
  bq?: BqDetails;
  sftp?: SftpDetails;
  visibility?: VisibilityWire;
  /** REST only — see DataSource.readOnly's doc comment in schema.prisma. */
  readOnly?: boolean;
  /** REST only — set when this connection was created via a guided preset. */
  presetKind?: "hubspot" | "zendesk";
};

export type RoleOption = { slug: string; label: string };
