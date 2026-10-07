/**
 * The "database connection" form of the engine admin console, as plain data: defaults per kind, what is valid,
 * and the request the engine wants. Messages are i18n keys (engineAdmin.databases.*), never English text, so the
 * screen decides the language.
 */
import type { ConnectionKind, ConnectionTestResult, EngineConnection, EngineView, TlsMode } from "./adminClient";

export const CONNECTION_KINDS: { kind: ConnectionKind; label: string; defaultPort: number }[] = [
  { kind: "POSTGRESQL", label: "PostgreSQL", defaultPort: 5432 },
  { kind: "MYSQL", label: "MySQL", defaultPort: 3306 },
  { kind: "MARIADB", label: "MariaDB", defaultPort: 3306 },
  { kind: "SQLSERVER", label: "SQL Server", defaultPort: 1433 },
  { kind: "ORACLE", label: "Oracle", defaultPort: 1521 },
  { kind: "TRINO", label: "Trino", defaultPort: 8080 },
];

export const TLS_MODES: TlsMode[] = ["VERIFY", "REQUIRE", "DISABLE"];

export function kindLabel(kind: string): string {
  return CONNECTION_KINDS.find((k) => k.kind === kind)?.label ?? kind;
}

export function defaultPort(kind: ConnectionKind): number {
  return CONNECTION_KINDS.find((k) => k.kind === kind)?.defaultPort ?? 5432;
}

export type ConnectionForm = {
  /** Set when editing. */
  id?: string;
  version?: number;
  /** An editing form remembers whether a password is already stored, so blank can mean "keep". */
  hasPassword: boolean;
  name: string;
  kind: ConnectionKind;
  host: string;
  /** Text, so a half-typed number is not forced into a value. */
  port: string;
  database: string;
  username: string;
  /** Write-only. Blank on edit = keep the stored one. */
  password: string;
  tlsMode: TlsMode;
  allowRawSql: boolean;
};

export function emptyConnectionForm(kind: ConnectionKind = "POSTGRESQL"): ConnectionForm {
  return { hasPassword: false, name: "", kind, host: "", port: String(defaultPort(kind)), database: "", username: "", password: "", tlsMode: "VERIFY", allowRawSql: false };
}

export function fromConnection(c: EngineConnection): ConnectionForm {
  return {
    id: c.id, version: c.version, hasPassword: c.hasPassword, name: c.name, kind: c.kind, host: c.host, port: String(c.port),
    database: c.database, username: c.username, password: "", tlsMode: c.tlsMode, allowRawSql: c.allowRawSql,
  };
}

/** Changing the kind moves the port with it, unless the admin already typed their own. */
export function changeKind(form: ConnectionForm, kind: ConnectionKind): ConnectionForm {
  const port = form.port.trim() === "" || form.port.trim() === String(defaultPort(form.kind)) ? String(defaultPort(kind)) : form.port;
  return { ...form, kind, port };
}

const DATABASE = /^[A-Za-z0-9_$.-]{1,128}$/;

export type ConnectionErrors = Partial<Record<"name" | "host" | "port" | "database" | "username" | "password", string>>;

/** i18n keys by field; empty when the form can be sent. */
export function validateConnection(form: ConnectionForm): ConnectionErrors {
  const errors: ConnectionErrors = {};
  const name = form.name.trim();
  if (!name) errors.name = "engineAdmin.databases.err.nameRequired";
  else if (name.length > 100) errors.name = "engineAdmin.databases.err.nameLong";

  const host = form.host.trim();
  if (!host) errors.host = "engineAdmin.databases.err.hostRequired";
  else if (/[\s/?#@\\]/.test(host) || host.includes("://")) errors.host = "engineAdmin.databases.err.hostShape";

  const port = form.port.trim();
  if (port !== "") {
    const n = Number(port);
    if (!/^\d+$/.test(port) || n < 1 || n > 65535) errors.port = "engineAdmin.databases.err.port";
  }

  const database = form.database.trim();
  if (!database) errors.database = "engineAdmin.databases.err.databaseRequired";
  else if (!DATABASE.test(database)) errors.database = "engineAdmin.databases.err.databaseShape";

  const username = form.username.trim();
  if (!username) errors.username = "engineAdmin.databases.err.usernameRequired";
  else if (username.length > 128) errors.username = "engineAdmin.databases.err.usernameLong";

  if (!form.id && form.password === "") errors.password = "engineAdmin.databases.err.passwordRequired";
  return errors;
}

/** The body for POST/PUT /connections. A blank password is left out, which keeps the stored one. */
export function toConnectionRequest(form: ConnectionForm): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: form.name.trim(),
    kind: form.kind,
    host: form.host.trim(),
    database: form.database.trim(),
    username: form.username.trim(),
    tlsMode: form.tlsMode,
    allowRawSql: form.allowRawSql,
  };
  if (form.port.trim() !== "") body.port = Number(form.port.trim());
  if (form.password !== "") body.password = form.password;
  if (form.id && form.version !== undefined) body.version = form.version;
  return body;
}

/** The engine's field name -> the form's. Anything unknown is shown at the top of the dialog. */
export function connectionField(engineField: string): keyof ConnectionErrors | "tlsMode" | "allowRawSql" | null {
  const f = engineField.replace(/\[.*$/, "").trim();
  return (["name", "host", "port", "database", "username", "password", "tlsMode", "allowRawSql"] as const).find((k) => k === f) ?? null;
}

export function describeTarget(c: Pick<EngineConnection, "host" | "port" | "database">): string {
  return `${c.host}:${c.port}/${c.database}`;
}

export type TestVerdict = "readOnly" | "canWrite" | "failed";

/** What the test means for an admin: a failed test says nothing about rights; a passing one is only good if it cannot write. */
export function testVerdict(result: ConnectionTestResult): TestVerdict {
  if (!result.ok) return "failed";
  return result.readOnlyVerified ? "readOnly" : "canWrite";
}

export function viewsUsingConnection(views: Pick<EngineView, "id" | "name" | "connectionId">[], connectionId: string): { id: string; name: string }[] {
  return views.filter((v) => v.connectionId === connectionId).map((v) => ({ id: v.id, name: v.name }));
}

/** Short names for a list of names: "A, B and 3 more" as parts, so the screen can translate the joiner. */
export function summariseNames(names: string[], shown = 5): { shown: string[]; more: number } {
  return { shown: names.slice(0, shown), more: Math.max(0, names.length - shown) };
}
