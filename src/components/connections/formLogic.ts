/**
 * Pure per-connector-kind logic for ConnectionForm — payload construction
 * and form validation. Pulled out of the component so the "what does each
 * connector kind need" question has exactly one answer instead of two
 * parallel 5-way branches that could silently drift apart when a 6th kind
 * (or a field change on an existing kind) gets added to only one of them.
 *
 * The JSX field-rendering branch stays in ConnectionForm.tsx — each kind's
 * form fields are genuinely different markup, not duplicated logic, so
 * unifying it here would trade one kind of complexity for another without
 * removing any real risk.
 */
import type { PickerKind, VisibilityWire } from "./types";

export type ConnectionFormFields = {
  kind: PickerKind;
  name: string;
  /** True when editing an existing connection — relaxes password/credential requiredness. */
  editing: boolean;
  connection: string;
  baseUrl: string;
  /** undefined = admin didn't touch the headers field — server keeps the stored (encrypted) headers. */
  headers?: Record<string, string>;
  visibility: VisibilityWire;
  /** REST only — see DataSource.readOnly's doc comment in schema.prisma. */
  readOnly: boolean;
  pg: { host: string; port: number; database: string; user: string; password: string; schema: string; ssl: boolean };
  my: { host: string; port: number; database: string; user: string; password: string; ssl: boolean };
  sf: { account: string; username: string; password: string; warehouse: string; database: string; schema: string; role: string };
  bq: { projectId: string; dataset: string; location: string; credentialsJson: string };
  /** HubSpot preset — see lib/connections/hubspot.ts. */
  hs: { accessToken: string };
  /** Zendesk preset — see lib/connections/zendesk.ts. */
  zd: { subdomain: string; email: string; apiToken: string };
  /** SFTP — see lib/connections/sftp.ts. Feeds lake pulls, not report queries. */
  sftp: { host: string; port: number; username: string; authMethod: "password" | "privateKey"; password: string; privateKey: string; passphrase: string; remotePath: string };
};

/** Builds the POST/PATCH body for /api/data-sources from the current form fields. */
export function buildConnectionPayload(f: ConnectionFormFields): Record<string, unknown> {
  const { kind, name } = f;
  switch (kind) {
    case "rest":
      return {
        kind, name, baseUrl: f.baseUrl,
        // Untouched (undefined) headers field on edit means "keep the stored
        // ones" — same "leave blank to reuse the stored secret" convention
        // as the password/credentialsJson fields below.
        ...(f.headers !== undefined ? { headers: f.headers } : {}),
        visibility: f.visibility,
        readOnly: f.readOnly,
      };
    // HubSpot/Zendesk are guided presets over "rest" — the wire kind is
    // always "rest", with an optional `preset` the server resolves into
    // baseUrl/headers (see data-sources/route.ts's resolveRestPreset()).
    // Omitting `preset` on edit (fields left blank) means "keep the
    // existing stored credentials", same convention as every password
    // field below.
    case "hubspot":
      return {
        kind: "rest", name,
        visibility: f.visibility,
        readOnly: f.readOnly,
        ...(f.hs.accessToken ? { preset: { kind: "hubspot", accessToken: f.hs.accessToken } } : {}),
      };
    case "zendesk":
      return {
        kind: "rest", name,
        visibility: f.visibility,
        readOnly: f.readOnly,
        ...(f.zd.subdomain && f.zd.email && f.zd.apiToken
          ? { preset: { kind: "zendesk", subdomain: f.zd.subdomain, email: f.zd.email, apiToken: f.zd.apiToken } }
          : {}),
      };
    case "postgres":
      return {
        kind, name,
        host: f.pg.host, port: f.pg.port, database: f.pg.database, user: f.pg.user,
        // Empty password on edit means "reuse the stored one"; on create the API rejects empty.
        ...(f.pg.password ? { password: f.pg.password } : {}),
        schema: f.pg.schema, ssl: f.pg.ssl,
        visibility: f.visibility,
      };
    case "mysql":
      return {
        kind, name,
        host: f.my.host, port: f.my.port, database: f.my.database, user: f.my.user,
        ...(f.my.password ? { password: f.my.password } : {}),
        ssl: f.my.ssl,
        visibility: f.visibility,
      };
    case "snowflake":
      return {
        kind, name,
        account: f.sf.account, username: f.sf.username,
        ...(f.sf.password ? { password: f.sf.password } : {}),
        warehouse: f.sf.warehouse, database: f.sf.database,
        schema: f.sf.schema || "PUBLIC",
        // Empty role string means "use the user's default role" — let the API see it as undefined.
        ...(f.sf.role.trim() ? { role: f.sf.role.trim() } : {}),
        visibility: f.visibility,
      };
    case "bigquery":
      return {
        kind, name,
        projectId: f.bq.projectId, dataset: f.bq.dataset,
        ...(f.bq.location.trim() ? { location: f.bq.location.trim() } : {}),
        // Empty credentialsJson on edit means "reuse the stored service-account JSON".
        ...(f.bq.credentialsJson.trim() ? { credentialsJson: f.bq.credentialsJson } : {}),
        visibility: f.visibility,
      };
    case "sftp":
      return {
        kind, name,
        host: f.sftp.host, port: f.sftp.port, username: f.sftp.username, authMethod: f.sftp.authMethod,
        // Leave-blank-to-keep, same convention as every password field above
        // — only the secret matching the active authMethod is ever sent.
        ...(f.sftp.authMethod === "password" && f.sftp.password ? { password: f.sftp.password } : {}),
        ...(f.sftp.authMethod === "privateKey" && f.sftp.privateKey ? { privateKey: f.sftp.privateKey } : {}),
        ...(f.sftp.authMethod === "privateKey" && f.sftp.passphrase ? { passphrase: f.sftp.passphrase } : {}),
        remotePath: f.sftp.remotePath,
        visibility: f.visibility,
      };
    default:
      return { kind, name, connection: f.connection, visibility: f.visibility };
  }
}

/** True when the currently-selected kind's required fields are filled in. */
export function isConnectionKindValid(f: ConnectionFormFields): boolean {
  switch (f.kind) {
    case "rest":
      return !!f.baseUrl;
    case "hubspot":
      return f.editing || !!f.hs.accessToken;
    case "zendesk":
      return f.editing || (!!f.zd.subdomain && !!f.zd.email && !!f.zd.apiToken);
    case "postgres":
      return !!f.pg.host && !!f.pg.database && !!f.pg.user && (f.editing || !!f.pg.password);
    case "mysql":
      return !!f.my.host && !!f.my.database && !!f.my.user && (f.editing || !!f.my.password);
    case "snowflake":
      return !!f.sf.account && !!f.sf.username && !!f.sf.warehouse && !!f.sf.database && (f.editing || !!f.sf.password);
    case "bigquery":
      return !!f.bq.projectId && !!f.bq.dataset && (f.editing || !!f.bq.credentialsJson.trim());
    case "sftp":
      return !!f.sftp.host && !!f.sftp.username && !!f.sftp.remotePath && (
        f.editing || (f.sftp.authMethod === "password" ? !!f.sftp.password : !!f.sftp.privateKey)
      );
    default:
      return !!f.connection;
  }
}
