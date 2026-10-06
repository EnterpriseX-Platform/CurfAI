"use client";
/**
 * Shared connection-editing form. Rendered by both the full-page Connections
 * manager (app/(main)/connections/DataSourcesManager) and the Report
 * Builder's Data drawer (components/designer/DataDrawer).
 *
 * Supports all seven connector kinds (rest, sqlite, excel upload, postgres,
 * mysql, snowflake, bigquery). Call sites can restrict the kind picker via
 * `allowedKinds` — the drawer passes ["rest", "sqlite"]; everything else is
 * identical between surfaces.
 */
import { Fragment, useEffect, useRef, useState } from "react";
import { Plus, Play, X as CloseIcon, FileSpreadsheet, Upload, Lock, Users as UsersIcon, User as UserIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/lib/toast";
import { UpgradeLock, isFeatureAvailable } from "@/components/common/UpgradeLock";
import { InlineTagManager } from "@/components/common/InlineTagManager";
import {
  KIND_FEATURE,
  type DataSourceKind,
  type PickerKind,
  type EditingConnection,
  type RoleOption,
  type VisibilityWire,
} from "./types";
import { buildConnectionPayload, isConnectionKindValid, type ConnectionFormFields } from "./formLogic";
import { eeClient } from "@/ee/client";
import { useT } from "@/lib/i18n/LocaleContext";

/** Every connector kind, in kind-picker order. Default for `allowedKinds`. */
const ALL_KINDS: DataSourceKind[] = ["rest", "sqlite", "excel", "postgres", "mysql", "snowflake", "bigquery", "sftp", "engine"];

/** Default for `roleOptions`. Must be one stable array: the mirror effect
 *  below depends on its identity, and a fresh `[]` per render re-fires it
 *  forever (the Data drawer, which passes none, hit "Maximum update depth"). */
const NO_ROLE_OPTIONS: RoleOption[] = [];

/** What a Test button last returned; `pending` while the request is in flight. */
type TestResultState = { pending?: boolean; ok?: boolean; status?: number; durationMs?: number; method?: string; url?: string; preview?: string; error?: string };

const SELECT_1 = <span className="font-mono">SELECT 1</span>;

export function ConnectionForm({
  editing, onSaved, roleOptions = NO_ROLE_OPTIONS, onRoleOptionsChange, currentTier, allowedKinds, onSaveAsQuery,
}: {
  editing: EditingConnection | null;
  onSaved: () => void;
  /** Role catalog for the visibility picker. Empty when the caller can't read /api/admin/roles. */
  roleOptions?: RoleOption[];
  /** Notified when the picker creates/deletes a tag, so a caller tracking its own roleOptions list (e.g. DataSourcesManager) stays in sync. Optional — callers that don't track the catalog (e.g. the designer's Data drawer) can omit it; the picker still works locally. */
  onRoleOptionsChange?: (next: RoleOption[]) => void;
  /** Tenant tier for connector gating. Only consulted when a gated kind is in `allowedKinds`. */
  currentTier?: string;
  /** Restrict the kind picker to these kinds. Default: all seven. */
  allowedKinds?: DataSourceKind[];
  /** Drawer-only: offered after a successful REST test to add the request as a report query. */
  onSaveAsQuery?: (spec: { connectionId: string; method: string; path: string; body: string }) => void;
}) {
  const kinds = allowedKinds ?? ALL_KINDS;
  const { push } = useToast();
  const { t } = useT();
  // "Password (leave blank to keep the existing one)" and friends, for any
  // secret the server already holds.
  const keepLabel = (hasExisting: unknown, label: string) =>
    hasExisting ? t("connectionForm.keepExisting").replace("{label}", label) : label;
  const alreadySetMasked = "•••••••• " + t("connectionForm.alreadySet");
  // Local mirror of roleOptions so the inline tag manager can add/delete
  // tags even when the caller doesn't track the catalog itself (the
  // designer's Data drawer never fetches /api/admin/roles).
  const [localRoleOptions, setLocalRoleOptions] = useState<RoleOption[]>(roleOptions);
  useEffect(() => { setLocalRoleOptions(roleOptions); }, [roleOptions]);
  function handleRoleOptionsChange(next: RoleOption[]) {
    setLocalRoleOptions(next);
    onRoleOptionsChange?.(next);
  }
  // presetKind (when set) picks the friendly HubSpot/Zendesk form on open —
  // the wire kind is always "rest" for those, presetKind is what tells us
  // which guided UI to show instead of raw baseUrl+headers.
  const [kind, setKind] = useState<PickerKind>(editing?.presetKind ?? editing?.kind ?? "rest");
  const [name, setName] = useState(editing?.name ?? "");
  const [connection, setConnection] = useState(editing?.connection ?? "");
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? "");
  // Header VALUES never come back from the server (see maskRestConnectionForClient) —
  // start blank on edit so the admin can't accidentally re-save what looks like
  // real values but is actually undefined. Leaving it blank keeps the stored headers.
  const [headersText, setHeadersText] = useState(editing ? "" : "{}");
  // Postgres fields. Password is intentionally NOT seeded from `editing` —
  // when editing an existing source the field starts empty and the existing
  // encrypted password is reused server-side unless the user types a new one.
  const [pgHost, setPgHost] = useState(editing?.pg?.host ?? "");
  const [pgPort, setPgPort] = useState<number>(editing?.pg?.port ?? 5432);
  const [pgDatabase, setPgDatabase] = useState(editing?.pg?.database ?? "");
  const [pgUser, setPgUser] = useState(editing?.pg?.user ?? "");
  const [pgPassword, setPgPassword] = useState("");
  const [pgSchema, setPgSchema] = useState(editing?.pg?.schema ?? "public");
  const [pgSsl, setPgSsl] = useState<boolean>(editing?.pg?.ssl ?? false);
  // MySQL fields. Same conventions as Postgres — password stays empty on edit
  // and the server reuses the encrypted value when the user doesn't retype it.
  const [myHost, setMyHost] = useState(editing?.my?.host ?? "");
  const [myPort, setMyPort] = useState<number>(editing?.my?.port ?? 3306);
  const [myDatabase, setMyDatabase] = useState(editing?.my?.database ?? "");
  const [myUser, setMyUser] = useState(editing?.my?.user ?? "");
  const [myPassword, setMyPassword] = useState("");
  const [mySsl, setMySsl] = useState<boolean>(editing?.my?.ssl ?? false);
  // Snowflake fields. account = locator (e.g. xy12345.us-east-1). The schema
  // and role get uppercased by the API before persisting; we accept whatever
  // case the admin types.
  const [sfAccount, setSfAccount] = useState(editing?.sf?.account ?? "");
  const [sfUsername, setSfUsername] = useState(editing?.sf?.username ?? "");
  const [sfPassword, setSfPassword] = useState("");
  const [sfWarehouse, setSfWarehouse] = useState(editing?.sf?.warehouse ?? "");
  const [sfDatabase, setSfDatabase] = useState(editing?.sf?.database ?? "");
  const [sfSchema, setSfSchema] = useState(editing?.sf?.schema ?? "PUBLIC");
  const [sfRole, setSfRole] = useState(editing?.sf?.role ?? "");
  // BigQuery fields. The credentialsJson textarea starts empty on edit so
  // admins can leave it blank to keep the existing encrypted blob.
  const [bqProjectId, setBqProjectId] = useState(editing?.bq?.projectId ?? "");
  const [bqDataset, setBqDataset] = useState(editing?.bq?.dataset ?? "");
  const [bqLocation, setBqLocation] = useState(editing?.bq?.location ?? "");
  const [bqCredentialsJson, setBqCredentialsJson] = useState("");
  // HubSpot/Zendesk preset fields. Secrets start blank on edit, same
  // "leave blank to keep the existing one" convention as every password
  // field above — see formLogic.ts's buildConnectionPayload.
  const [hsAccessToken, setHsAccessToken] = useState("");
  const [zdSubdomain, setZdSubdomain] = useState("");
  const [zdEmail, setZdEmail] = useState("");
  const [zdApiToken, setZdApiToken] = useState("");
  // SFTP fields — feeds only the scheduled lake pull (POST /api/lake/pulls),
  // never a live report query. Secrets start blank on edit, same convention.
  const [sftpHost, setSftpHost] = useState(editing?.sftp?.host ?? "");
  const [sftpPort, setSftpPort] = useState<number>(editing?.sftp?.port ?? 22);
  const [sftpUsername, setSftpUsername] = useState(editing?.sftp?.username ?? "");
  const [sftpAuthMethod, setSftpAuthMethod] = useState<"password" | "privateKey">(editing?.sftp?.authMethod ?? "password");
  const [sftpPassword, setSftpPassword] = useState("");
  const [sftpPrivateKey, setSftpPrivateKey] = useState("");
  const [sftpPassphrase, setSftpPassphrase] = useState("");
  const [sftpRemotePath, setSftpRemotePath] = useState(editing?.sftp?.remotePath ?? "");
  // Engine fields — no secret. A blank URL means the platform's own engine, so
  // an engine that is the platform's shows blank here rather than its address.
  const [engineBaseUrl, setEngineBaseUrl] = useState(editing?.engine && !editing.engine.usesPlatformEngine ? editing.engine.baseUrl : "");
  const [engineAudience, setEngineAudience] = useState(editing?.engine?.audience ?? "");
  const [visibility, setVisibility] = useState<VisibilityWire>(editing?.visibility ?? { mode: "tenant" });
  // REST only — see DataSource.readOnly's doc comment in schema.prisma.
  const [readOnly, setReadOnly] = useState<boolean>(editing?.readOnly ?? false);
  const [testMethod, setTestMethod] = useState<"POST" | "GET">("POST");
  const [testPath, setTestPath] = useState("/");
  const [testBody, setTestBody] = useState("{}");
  const [testResult, setTestResult] = useState<TestResultState | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Re-seed form state whenever `editing` switches (including back to null).
  useEffect(() => {
    setKind(editing?.presetKind ?? editing?.kind ?? "rest");
    setName(editing?.name ?? "");
    setConnection(editing?.connection ?? "");
    setBaseUrl(editing?.baseUrl ?? "");
    setHeadersText(editing ? "" : "{}");
    setPgHost(editing?.pg?.host ?? "");
    setPgPort(editing?.pg?.port ?? 5432);
    setPgDatabase(editing?.pg?.database ?? "");
    setPgUser(editing?.pg?.user ?? "");
    setPgPassword("");
    setPgSchema(editing?.pg?.schema ?? "public");
    setPgSsl(editing?.pg?.ssl ?? false);
    setMyHost(editing?.my?.host ?? "");
    setMyPort(editing?.my?.port ?? 3306);
    setMyDatabase(editing?.my?.database ?? "");
    setMyUser(editing?.my?.user ?? "");
    setMyPassword("");
    setMySsl(editing?.my?.ssl ?? false);
    setSfAccount(editing?.sf?.account ?? "");
    setSfUsername(editing?.sf?.username ?? "");
    setSfPassword("");
    setSfWarehouse(editing?.sf?.warehouse ?? "");
    setSfDatabase(editing?.sf?.database ?? "");
    setSfSchema(editing?.sf?.schema ?? "PUBLIC");
    setSfRole(editing?.sf?.role ?? "");
    setBqProjectId(editing?.bq?.projectId ?? "");
    setBqDataset(editing?.bq?.dataset ?? "");
    setBqLocation(editing?.bq?.location ?? "");
    setBqCredentialsJson("");
    setHsAccessToken("");
    setZdSubdomain("");
    setZdEmail("");
    setZdApiToken("");
    setSftpHost(editing?.sftp?.host ?? "");
    setSftpPort(editing?.sftp?.port ?? 22);
    setSftpUsername(editing?.sftp?.username ?? "");
    setSftpAuthMethod(editing?.sftp?.authMethod ?? "password");
    setSftpPassword("");
    setSftpPrivateKey("");
    setSftpPassphrase("");
    setSftpRemotePath(editing?.sftp?.remotePath ?? "");
    setEngineBaseUrl(editing?.engine && !editing.engine.usesPlatformEngine ? editing.engine.baseUrl : "");
    setEngineAudience(editing?.engine?.audience ?? "");
    setVisibility(editing?.visibility ?? { mode: "tenant" });
    setTestResult(null);
  }, [editing]);

  // Bundles all per-kind state into the shape formLogic.ts's pure helpers
  // expect. `headers` is a best-effort parse — submit() does its own strict
  // parse-or-abort before ever calling this, so an empty {} here only ever
  // shows up transiently while the user is mid-edit of the headers textarea.
  function currentFields(): ConnectionFormFields {
    // undefined (not {}) when the box is untouched, so buildConnectionPayload
    // knows to omit `headers` entirely and the server keeps the stored ones.
    let headers: Record<string, string> | undefined;
    if (headersText.trim()) {
      try { headers = JSON.parse(headersText); } catch { /* see above */ }
    }
    return {
      kind, name, editing: !!editing, connection, baseUrl, headers, visibility, readOnly,
      pg: { host: pgHost, port: pgPort, database: pgDatabase, user: pgUser, password: pgPassword, schema: pgSchema, ssl: pgSsl },
      my: { host: myHost, port: myPort, database: myDatabase, user: myUser, password: myPassword, ssl: mySsl },
      sf: { account: sfAccount, username: sfUsername, password: sfPassword, warehouse: sfWarehouse, database: sfDatabase, schema: sfSchema, role: sfRole },
      bq: { projectId: bqProjectId, dataset: bqDataset, location: bqLocation, credentialsJson: bqCredentialsJson },
      hs: { accessToken: hsAccessToken },
      zd: { subdomain: zdSubdomain, email: zdEmail, apiToken: zdApiToken },
      sftp: {
        host: sftpHost, port: sftpPort, username: sftpUsername, authMethod: sftpAuthMethod,
        password: sftpPassword, privateKey: sftpPrivateKey, passphrase: sftpPassphrase, remotePath: sftpRemotePath,
      },
      engine: { baseUrl: engineBaseUrl, audience: engineAudience },
    };
  }

  async function submit() {
    setSubmitting(true);
    try {
      if (headersText.trim()) {
        try { JSON.parse(headersText); }
        catch { push({ variant: "destructive", title: t("connectionForm.headersNotJson") }); setSubmitting(false); return; }
      }

      // Visibility shape on the wire is exactly the discriminator the API
      // expects. We omit `ownerUserId` from owner_only — the server binds it
      // to the current session user.
      const visibilityWire = visibility.mode === "roles"
        ? { mode: "roles" as const, roles: visibility.roles }
        : { mode: visibility.mode };
      const payload = buildConnectionPayload({ ...currentFields(), visibility: visibilityWire });
      const url = editing ? `/api/data-sources/${editing.id}` : "/api/data-sources";
      const method = editing ? "PATCH" : "POST";
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        let msg = await r.text();
        try {
          const body = JSON.parse(msg);
          // A 400 can carry per-field issues (e.g. a disallowed engine URL) —
          // show the field's own message when the top-level error is generic.
          const issue = Array.isArray(body.issues) ? body.issues[0]?.message : undefined;
          msg = issue && issue !== body.error ? [body.error, issue].filter(Boolean).join(": ") : (body.error ?? msg);
        } catch { /* keep text */ }
        push({ variant: "destructive", title: editing ? t("common.saveFailed") : t("connectionForm.addFailed"), description: msg });
        return;
      }
      push({ variant: "success", title: editing ? t("connectionForm.updated") : t("connectionForm.added") });
      if (!editing) {
        setName(""); setBaseUrl(""); setConnection(""); setHeadersText("{}");
        setHsAccessToken(""); setZdSubdomain(""); setZdEmail(""); setZdApiToken("");
        setSftpHost(""); setSftpUsername(""); setSftpPassword(""); setSftpPrivateKey(""); setSftpPassphrase(""); setSftpRemotePath("");
        setEngineBaseUrl(""); setEngineAudience("");
      }
      onSaved();
    } finally {
      setSubmitting(false);
    }
  }

  async function test() {
    setTestResult({ pending: true });
    try {
      // Blank headers box on an existing connection means "use the stored
      // ones" — rehydrate server-side by id instead of sending plaintext.
      const useStored = !!editing && headersText.trim().length === 0;
      const body: Record<string, unknown> = {
        baseUrl,
        method: testMethod,
        path: testPath || "/",
        body: testMethod === "POST" ? testBody : undefined,
      };
      if (useStored) {
        body.dataSourceId = editing!.id;
      } else {
        body.headers = headersText.trim() ? JSON.parse(headersText) : {};
      }
      const r = await fetch(`/api/data-sources/test-rest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setTestResult(await r.json());
    } catch (e: any) {
      setTestResult({ error: e?.message ?? t("common.requestFailed") });
    }
  }

  // HubSpot/Zendesk reuse the existing test-rest action — they're "rest"
  // connections under the hood (see lib/connections/hubspot.ts), so there's
  // no dedicated backend test route. account-info/v3/details and
  // users/me.json are both minimal, read-only "who am I" endpoints — enough
  // to confirm the token authenticates without needing any specific scope.
  async function testHubspot() {
    setTestResult({ pending: true });
    try {
      const useStored = !!editing && !hsAccessToken.trim();
      const body: Record<string, unknown> = { path: "/account-info/v3/details", method: "GET" };
      if (useStored) {
        body.dataSourceId = editing!.id;
      } else {
        body.baseUrl = eeClient.connectors?.hubspotBaseUrl ?? "";
        body.headers = { Authorization: `Bearer ${hsAccessToken.trim()}` };
      }
      const r = await fetch(`/api/data-sources/test-rest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setTestResult(await r.json());
    } catch (e: any) {
      setTestResult({ error: e?.message ?? t("common.requestFailed") });
    }
  }

  async function testZendesk() {
    setTestResult({ pending: true });
    try {
      const useStored = !!editing && !zdEmail.trim() && !zdApiToken.trim();
      const body: Record<string, unknown> = { path: "/users/me.json", method: "GET" };
      if (useStored) {
        body.dataSourceId = editing!.id;
      } else {
        // Client-safe Basic-auth encoding (btoa) — the authoritative,
        // encrypted-at-rest version is built server-side via the Node-only
        // zendeskAuthHeaders() when the connection is actually saved.
        body.baseUrl = eeClient.connectors?.zendeskBaseUrl?.(zdSubdomain) ?? "";
        body.headers = { Authorization: `Basic ${btoa(`${zdEmail.trim()}/token:${zdApiToken.trim()}`)}` };
      }
      const r = await fetch(`/api/data-sources/test-rest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setTestResult(await r.json());
    } catch (e: any) {
      setTestResult({ error: e?.message ?? t("common.requestFailed") });
    }
  }

  async function testSqlite() {
    setTestResult({ pending: true });
    try {
      const r = await fetch(`/api/data-sources/test-sqlite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connection }),
      });
      setTestResult(await r.json());
    } catch (e: any) {
      setTestResult({ error: e?.message ?? t("common.requestFailed") });
    }
  }

  async function testPostgres() {
    setTestResult({ pending: true });
    try {
      // When editing an existing source AND the password field is empty,
      // ask the server to rehydrate the stored credentials by id. Otherwise
      // pass plaintext in the body.
      const useStored = !!editing && pgPassword.length === 0;
      const body = useStored
        ? { dataSourceId: editing!.id }
        : {
            host: pgHost, port: pgPort, database: pgDatabase, user: pgUser,
            password: pgPassword, schema: pgSchema, ssl: pgSsl,
          };
      const r = await fetch(`/api/data-sources/test-postgres`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setTestResult(await r.json());
    } catch (e: any) {
      setTestResult({ error: e?.message ?? t("common.requestFailed") });
    }
  }

  async function testMysql() {
    setTestResult({ pending: true });
    try {
      // Same stored-credentials trick as testPostgres: when editing and the
      // password field is empty, rehydrate from the encrypted DB row.
      const useStored = !!editing && myPassword.length === 0;
      const body = useStored
        ? { dataSourceId: editing!.id }
        : {
            host: myHost, port: myPort, database: myDatabase, user: myUser,
            password: myPassword, ssl: mySsl,
          };
      const r = await fetch(`/api/data-sources/test-mysql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setTestResult(await r.json());
    } catch (e: any) {
      setTestResult({ error: e?.message ?? t("common.requestFailed") });
    }
  }

  async function testSnowflake() {
    setTestResult({ pending: true });
    try {
      const useStored = !!editing && sfPassword.length === 0;
      const body = useStored
        ? { dataSourceId: editing!.id }
        : {
            account: sfAccount, username: sfUsername, password: sfPassword,
            warehouse: sfWarehouse, database: sfDatabase, schema: sfSchema || "PUBLIC",
            ...(sfRole.trim() ? { role: sfRole.trim() } : {}),
          };
      const r = await fetch(`/api/data-sources/test-snowflake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setTestResult(await r.json());
    } catch (e: any) {
      setTestResult({ error: e?.message ?? t("common.requestFailed") });
    }
  }

  async function testBigQuery() {
    setTestResult({ pending: true });
    try {
      // Same stored-credentials trick: editing + empty credentialsJson =
      // rehydrate from the encrypted DB row. Otherwise pass plaintext.
      const useStored = !!editing && bqCredentialsJson.trim().length === 0;
      const body = useStored
        ? { dataSourceId: editing!.id }
        : {
            projectId: bqProjectId, dataset: bqDataset,
            ...(bqLocation.trim() ? { location: bqLocation.trim() } : {}),
            credentialsJson: bqCredentialsJson,
          };
      const r = await fetch(`/api/data-sources/test-bigquery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setTestResult(await r.json());
    } catch (e: any) {
      setTestResult({ error: e?.message ?? t("common.requestFailed") });
    }
  }

  async function testSftp() {
    setTestResult({ pending: true });
    try {
      const useStored = !!editing && (sftpAuthMethod === "password" ? !sftpPassword.trim() : !sftpPrivateKey.trim());
      const body = useStored
        ? { dataSourceId: editing!.id }
        : {
            host: sftpHost, port: sftpPort, username: sftpUsername, authMethod: sftpAuthMethod,
            ...(sftpAuthMethod === "password" ? { password: sftpPassword } : { privateKey: sftpPrivateKey, passphrase: sftpPassphrase || undefined }),
            remotePath: sftpRemotePath,
          };
      const r = await fetch(`/api/data-sources/test-sftp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setTestResult(await r.json());
    } catch (e: any) {
      setTestResult({ error: e?.message ?? t("common.requestFailed") });
    }
  }

  // Excel uploads are a totally different shape (file upload + parse preview),
  // so we delegate to a dedicated subform when that kind is selected. The
  // parent still owns the kind picker so users discover the option in the
  // same place they pick REST or SQLite.
  if (kind === "excel" && !editing) {
    return (
      <div className="grid gap-3 rounded-lg border bg-card p-5 shadow-xs">
        <div className="grid grid-cols-[140px_1fr] gap-3">
          <F label={t("connections.kindHeader")}>
            <Select value={kind} onValueChange={(v) => setKind(v as DataSourceKind)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {kinds.includes("rest") && <SelectItem value="rest">REST API</SelectItem>}
                {kinds.includes("sqlite") && <SelectItem value="sqlite">{t("connectionForm.kind.sqlite")}</SelectItem>}
                {kinds.includes("excel") && <SelectItem value="excel">{t("connectionForm.kind.excel")}</SelectItem>}
              </SelectContent>
            </Select>
          </F>
          <div />
        </div>
        <ExcelUploadForm onSaved={onSaved} roleOptions={localRoleOptions} onRoleOptionsChange={handleRoleOptionsChange} />
      </div>
    );
  }

  return (
    <div className="grid gap-3 rounded-lg border bg-card p-5 shadow-xs">
      <div className="grid grid-cols-[140px_1fr] gap-3">
        <F label={t("connections.kindHeader")}>
          <Select value={kind} onValueChange={(v) => setKind(v as PickerKind)} disabled={!!editing}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {kinds.includes("rest") && <SelectItem value="rest">REST API</SelectItem>}
              {/* Guided REST presets — persist as kind="rest" under the hood
                  (see lib/connections/hubspot.ts), so gated on the same
                  "rest" allowance rather than a separate kinds entry. */}
              {kinds.includes("rest") && eeClient.connectors?.hubspotBaseUrl && <SelectItem value="hubspot">HubSpot CRM</SelectItem>}
              {kinds.includes("rest") && eeClient.connectors?.zendeskBaseUrl && <SelectItem value="zendesk">Zendesk</SelectItem>}
              {kinds.includes("sqlite") && <SelectItem value="sqlite">{t("connectionForm.kind.sqlite")}</SelectItem>}
              {kinds.includes("excel") && <SelectItem value="excel">{t("connectionForm.kind.excel")}</SelectItem>}
              {/* Tier-gated kinds. Picking a locked option still works — we
                  show an UpgradeLock card below where the form would normally
                  render, so users can see what they'd be unlocking. */}
              {kinds.includes("postgres") && (
                <SelectItem value="postgres">{t("connectionForm.kind.postgres")}</SelectItem>
              )}
              {kinds.includes("mysql") && (
                <SelectItem value="mysql">{t("connectionForm.kind.mysql")}</SelectItem>
              )}
              {kinds.includes("snowflake") && (
                <SelectItem value="snowflake">
                  <span className="inline-flex items-center gap-2 whitespace-nowrap">
                    {t("connectionForm.kind.snowflake")}
                    {!isFeatureAvailable(currentTier, "connector.snowflake") && (
                      <UpgradeLock feature="connector.snowflake" currentTier={currentTier} variant="inline" />
                    )}
                  </span>
                </SelectItem>
              )}
              {kinds.includes("bigquery") && (
                <SelectItem value="bigquery">
                  <span className="inline-flex items-center gap-2 whitespace-nowrap">
                    {t("connectionForm.kind.bigquery")}
                    {!isFeatureAvailable(currentTier, "connector.bigquery") && (
                      <UpgradeLock feature="connector.bigquery" currentTier={currentTier} variant="inline" />
                    )}
                  </span>
                </SelectItem>
              )}
              {/* Feeds only the scheduled lake pull (POST /api/lake/pulls),
                  never a live report query — see lib/connections/sftp.ts. */}
              {kinds.includes("sftp") && (
                <SelectItem value="sftp">
                  <span className="inline-flex items-center gap-2 whitespace-nowrap">
                    {t("connectionForm.kind.sftp")}
                    {!isFeatureAvailable(currentTier, "connector.sftp") && (
                      <UpgradeLock feature="connector.sftp" currentTier={currentTier} variant="inline" />
                    )}
                  </span>
                </SelectItem>
              )}
              {kinds.includes("engine") && (
                <SelectItem value="engine">
                  <span className="inline-flex items-center gap-2 whitespace-nowrap">
                    {t("connectionForm.kind.engine")}
                    {!isFeatureAvailable(currentTier, "connector.engine") && (
                      <UpgradeLock feature="connector.engine" currentTier={currentTier} variant="inline" />
                    )}
                  </span>
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        </F>
        <F label={t("common.name")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("common.eg").replace("{example}", "orders_api")} />
        </F>
      </div>
      <VisibilityPicker value={visibility} onChange={setVisibility} roleOptions={localRoleOptions} onRoleOptionsChange={handleRoleOptionsChange} />

      {/* REST only — SQL-kind sources are already unconditionally SELECT-only
          via assertSelectOnly regardless of any flag, so a checkbox here for
          them would be misleading (it could never actually change anything). */}
      {kind === "rest" && (
        <label className="mt-3 flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-xs">
          <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
          {t("connectionForm.readOnly")}
        </label>
      )}

      {/* When the picked kind is gated by tier and the tenant doesn't have
          access, replace the form fields with an UpgradeLock card. The kind
          picker remains interactive so users can try different connectors
          and see which ones are unlocked at their tier. */}
      {/* hubspot/zendesk aren't real DataSourceKind values (never gated —
          see lib/connections/hubspot.ts) so this cast is safe: the lookup
          just misses and KIND_FEATURE[kind] is undefined for them. */}
      {KIND_FEATURE[kind as DataSourceKind] && !isFeatureAvailable(currentTier, KIND_FEATURE[kind as DataSourceKind]!) ? (
        <UpgradeLock feature={KIND_FEATURE[kind as DataSourceKind]!} currentTier={currentTier} />
      ) : kind === "rest" ? (
        <>
          <F label={t("connectionForm.baseUrl")}>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com" />
          </F>
          <F label={editing && editing.hasHeaders
            ? t("connectionForm.headersKeep")
                .replace("{n}", String(editing.headerKeys?.length ?? 0))
                .replace("{plural}", (editing.headerKeys?.length ?? 0) === 1 ? "" : "s")
                .replace("{keys}", (editing.headerKeys ?? []).join(", "))
            : t("connectionForm.headers")}>
            <textarea
              className="min-h-[88px] rounded-md border border-input bg-background p-2 font-mono text-xs"
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
              placeholder={editing && editing.hasHeaders ? "{}" : undefined}
            />
          </F>
          <div className="grid gap-2 rounded-md border border-dashed border-border/80 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("connectionForm.testRequest")}</p>
            <div className="grid grid-cols-[120px_1fr] gap-2">
              <F label={t("dataDrawer.method")}>
                <Select value={testMethod} onValueChange={(v) => setTestMethod(v as any)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="POST">POST</SelectItem>
                    <SelectItem value="GET">GET</SelectItem>
                  </SelectContent>
                </Select>
              </F>
              <F label={t("connectionForm.path")}>
                <Input value={testPath} onChange={(e) => setTestPath(e.target.value)} placeholder="/" />
              </F>
            </div>
            {testMethod === "POST" && (
              <F label={t("connectionForm.body")}>
                <textarea
                  className="min-h-[80px] rounded-md border border-input bg-background p-2 font-mono text-xs"
                  value={testBody}
                  onChange={(e) => setTestBody(e.target.value)}
                  placeholder='{"ping":true}'
                />
              </F>
            )}
            <div>
              <Button size="sm" variant="outline" onClick={test} disabled={!baseUrl} type="button">
                <Play className="mr-1.5 h-4 w-4" /> {t("connectionForm.testMethodPath").replace("{method}", testMethod).replace("{path}", testPath || "/")}
              </Button>
            </div>
            <TestResult result={testResult} rest />
            {/* Drawer-only affordance: after a successful test against a saved
                connection, offer to add the request to the report's Queries
                tab. Only rendered when the caller wires `onSaveAsQuery`. */}
            {testResult?.ok && onSaveAsQuery && editing?.id && (
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => onSaveAsQuery({
                    connectionId: editing.id,
                    method: testMethod,
                    path: testPath || "/",
                    body: testMethod === "POST" ? testBody : "",
                  })}
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" /> {t("connectionForm.saveAsQuery")}
                </Button>
                <span className="text-[11px] text-muted-foreground">{t("connectionForm.saveAsQueryHint")}</span>
              </div>
            )}
          </div>
        </>
      ) : kind === "hubspot" ? (
        <>
          <F label={keepLabel(editing && editing.hasHeaders, t("connectionForm.hsToken"))}>
            <Input
              type="password"
              value={hsAccessToken}
              onChange={(e) => setHsAccessToken(e.target.value)}
              placeholder={editing && editing.hasHeaders ? alreadySetMasked : "pat-na1-..."}
              autoComplete="new-password"
            />
          </F>
          <p className="text-xs text-muted-foreground">
            {fill(t("connectionForm.hsHelp"), { url: <span className="font-mono">{eeClient.connectors?.hubspotBaseUrl}</span> })}
          </p>
          <div className="grid gap-2 rounded-md border border-dashed border-border/80 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("connectionForm.testConnection")}</p>
            <p className="text-xs text-muted-foreground">{t("connectionForm.hsTestHint")}</p>
            <div>
              <Button
                size="sm" variant="outline" type="button" onClick={testHubspot}
                disabled={!hsAccessToken && !(editing && editing.hasHeaders)}
              >
                <Play className="mr-1.5 h-4 w-4" /> {t("connectionForm.testConnection")}
              </Button>
            </div>
            <TestResult result={testResult} />
          </div>
        </>
      ) : kind === "zendesk" ? (
        <>
          <F label={t("connectionForm.subdomain")}>
            <Input
              value={zdSubdomain}
              onChange={(e) => setZdSubdomain(e.target.value)}
              placeholder={t("connectionForm.subdomainPlaceholder")}
            />
          </F>
          <div className="grid grid-cols-2 gap-3">
            <F label={t("connectionForm.agentEmail")}>
              <Input value={zdEmail} onChange={(e) => setZdEmail(e.target.value)} placeholder="agent@acme.com" />
            </F>
            <F label={keepLabel(editing && editing.hasHeaders, t("connectionForm.apiToken"))}>
              <Input
                type="password"
                value={zdApiToken}
                onChange={(e) => setZdApiToken(e.target.value)}
                placeholder={editing && editing.hasHeaders ? alreadySetMasked : t("connectionForm.apiToken")}
                autoComplete="new-password"
              />
            </F>
          </div>
          <p className="text-xs text-muted-foreground">
            {fill(t("connectionForm.zdHelp"), {
              url: <span className="font-mono">{zdSubdomain && eeClient.connectors?.zendeskBaseUrl ? eeClient.connectors.zendeskBaseUrl(zdSubdomain) : "https://<subdomain>.zendesk.com/api/v2"}</span>,
            })}
          </p>
          <div className="grid gap-2 rounded-md border border-dashed border-border/80 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("connectionForm.testConnection")}</p>
            <p className="text-xs text-muted-foreground">{t("connectionForm.zdTestHint")}</p>
            <div>
              <Button
                size="sm" variant="outline" type="button" onClick={testZendesk}
                disabled={editing && editing.hasHeaders ? !zdSubdomain : !zdSubdomain || !zdEmail || !zdApiToken}
              >
                <Play className="mr-1.5 h-4 w-4" /> {t("connectionForm.testConnection")}
              </Button>
            </div>
            <TestResult result={testResult} />
          </div>
        </>
      ) : kind === "postgres" ? (
        <>
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <F label={t("admin.newConnectionWizard.host")}>
              <Input value={pgHost} onChange={(e) => setPgHost(e.target.value)} placeholder="db.example.com" />
            </F>
            <F label={t("admin.newConnectionWizard.port")}>
              <Input
                type="number"
                value={pgPort}
                onChange={(e) => setPgPort(Number(e.target.value) || 5432)}
              />
            </F>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <F label={t("admin.newConnectionWizard.database")}>
              <Input value={pgDatabase} onChange={(e) => setPgDatabase(e.target.value)} placeholder="appdb" />
            </F>
            <F label={t("admin.newConnectionWizard.user")}>
              <Input value={pgUser} onChange={(e) => setPgUser(e.target.value)} placeholder="readonly_user" />
            </F>
          </div>
          <F label={keepLabel(editing && editing.pg?.hasPassword, t("admin.newConnectionWizard.password"))}>
            <Input
              type="password"
              value={pgPassword}
              onChange={(e) => setPgPassword(e.target.value)}
              placeholder={editing && editing.pg?.hasPassword ? alreadySetMasked : t("connectionForm.dbPassword")}
              autoComplete="new-password"
            />
          </F>
          <div className="grid grid-cols-[1fr_140px] gap-3">
            <F label={t("connectionForm.schemaDefault").replace("{value}", "public")}>
              <Input value={pgSchema} onChange={(e) => setPgSchema(e.target.value)} placeholder="public" />
            </F>
            <F label={t("admin.newConnectionWizard.ssl")}>
              <label className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-xs">
                <input type="checkbox" checked={pgSsl} onChange={(e) => setPgSsl(e.target.checked)} />
                {t("connectionForm.requireSsl")}
              </label>
            </F>
          </div>
          <div className="grid gap-2 rounded-md border border-dashed border-border/80 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("connectionForm.testConnection")}</p>
            <p className="text-xs text-muted-foreground">
              {fill(t("connectionForm.dbTestHint"), { sql: SELECT_1, target: <span className="font-mono">{pgSchema || "public"}</span> })}
              {editing && pgPassword.length === 0 && editing.pg?.hasPassword ? ` ${t("connectionForm.usingStoredPassword")}` : ""}
            </p>
            <div>
              <Button
                size="sm" variant="outline" type="button" onClick={testPostgres}
                disabled={!pgHost || !pgDatabase || !pgUser || (!editing && !pgPassword)}
              >
                <Play className="mr-1.5 h-4 w-4" /> {t("connectionForm.testConnection")}
              </Button>
            </div>
            <TestResult result={testResult} />
          </div>
        </>
      ) : kind === "mysql" ? (
        <>
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <F label={t("admin.newConnectionWizard.host")}>
              <Input value={myHost} onChange={(e) => setMyHost(e.target.value)} placeholder="db.example.com" />
            </F>
            <F label={t("admin.newConnectionWizard.port")}>
              <Input
                type="number"
                value={myPort}
                onChange={(e) => setMyPort(Number(e.target.value) || 3306)}
              />
            </F>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <F label={t("admin.newConnectionWizard.database")}>
              <Input value={myDatabase} onChange={(e) => setMyDatabase(e.target.value)} placeholder="appdb" />
            </F>
            <F label={t("admin.newConnectionWizard.user")}>
              <Input value={myUser} onChange={(e) => setMyUser(e.target.value)} placeholder="readonly_user" />
            </F>
          </div>
          <F label={keepLabel(editing && editing.my?.hasPassword, t("admin.newConnectionWizard.password"))}>
            <Input
              type="password"
              value={myPassword}
              onChange={(e) => setMyPassword(e.target.value)}
              placeholder={editing && editing.my?.hasPassword ? alreadySetMasked : t("connectionForm.dbPassword")}
              autoComplete="new-password"
            />
          </F>
          <div className="grid grid-cols-[140px_1fr] gap-3">
            <F label={t("admin.newConnectionWizard.ssl")}>
              <label className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-xs">
                <input type="checkbox" checked={mySsl} onChange={(e) => setMySsl(e.target.checked)} />
                {t("connectionForm.requireSsl")}
              </label>
            </F>
            <div />
          </div>
          <div className="grid gap-2 rounded-md border border-dashed border-border/80 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("connectionForm.testConnection")}</p>
            <p className="text-xs text-muted-foreground">
              {fill(t("connectionForm.dbTestHint"), {
                sql: SELECT_1,
                target: <span className="font-mono">{myDatabase || `(${t("admin.newConnectionWizard.database")})`}</span>,
              })}
              {editing && myPassword.length === 0 && editing.my?.hasPassword ? ` ${t("connectionForm.usingStoredPassword")}` : ""}
            </p>
            <div>
              <Button
                size="sm" variant="outline" type="button" onClick={testMysql}
                disabled={!myHost || !myDatabase || !myUser || (!editing && !myPassword)}
              >
                <Play className="mr-1.5 h-4 w-4" /> {t("connectionForm.testConnection")}
              </Button>
            </div>
            <TestResult result={testResult} />
          </div>
        </>
      ) : kind === "bigquery" ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <F label={t("connectionForm.projectId")}>
              <Input value={bqProjectId} onChange={(e) => setBqProjectId(e.target.value)} placeholder="my-gcp-project" />
            </F>
            <F label={t("connectionForm.dataset")}>
              <Input value={bqDataset} onChange={(e) => setBqDataset(e.target.value)} placeholder="analytics" />
            </F>
          </div>
          <F label={t("connectionForm.bqLocation")}>
            <Input value={bqLocation} onChange={(e) => setBqLocation(e.target.value)} placeholder="US" />
          </F>
          <F label={editing && editing.bq?.hasCredentials
            ? t("connectionForm.bqCredsKeep").replace("{key}", editing.bq?.clientEmail || t("connectionForm.bqExistingKey"))
            : t("connectionForm.bqCreds")}>
            <textarea
              className="min-h-[180px] rounded-md border border-input bg-background p-2 font-mono text-[11px]"
              value={bqCredentialsJson}
              onChange={(e) => setBqCredentialsJson(e.target.value)}
              placeholder={editing && editing.bq?.hasCredentials
                ? `{"type":"service_account","client_email":"${editing.bq?.clientEmail || "..."}",…}`
                : `{
  "type": "service_account",
  "project_id": "...",
  "client_email": "...@....iam.gserviceaccount.com",
  "private_key": "-----BEGIN PRIVATE KEY-----\
…",
  …
}`}
              spellCheck={false}
            />
          </F>
          <div className="grid gap-2 rounded-md border border-dashed border-border/80 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("connectionForm.testConnection")}</p>
            <p className="text-xs text-muted-foreground">
              {fill(t("connectionForm.bqTestHint"), {
                sql: SELECT_1,
                target: <span className="font-mono">{bqProjectId || "project"}.{bqDataset || "dataset"}</span>,
              })}
              {editing && bqCredentialsJson.trim().length === 0 && editing.bq?.hasCredentials ? ` ${t("connectionForm.usingStoredCreds")}` : ""}
            </p>
            <div>
              <Button
                size="sm" variant="outline" type="button" onClick={testBigQuery}
                disabled={!bqProjectId || !bqDataset || (!editing && !bqCredentialsJson.trim())}
              >
                <Play className="mr-1.5 h-4 w-4" /> {t("connectionForm.testConnection")}
              </Button>
            </div>
            <TestResult result={testResult} />
          </div>
        </>
      ) : kind === "sftp" ? (
        <>
          <p className="text-xs text-muted-foreground">
            {t("connectionForm.sftpIntro").replace("{remotePath}", t("connectionForm.remotePath"))}
          </p>
          <div className="grid grid-cols-[1fr_100px] gap-3">
            <F label={t("admin.newConnectionWizard.host")}>
              <Input value={sftpHost} onChange={(e) => setSftpHost(e.target.value)} placeholder="sftp.example.com" />
            </F>
            <F label={t("admin.newConnectionWizard.port")}>
              <Input type="number" value={sftpPort} onChange={(e) => setSftpPort(Number(e.target.value) || 22)} />
            </F>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <F label={t("connectors.usernameLabel")}>
              <Input value={sftpUsername} onChange={(e) => setSftpUsername(e.target.value)} placeholder="report_reader" />
            </F>
            <F label={t("connectionForm.remotePath")}>
              <Input value={sftpRemotePath} onChange={(e) => setSftpRemotePath(e.target.value)} placeholder="/exports/orders.csv" />
            </F>
          </div>
          <F label={t("connectionForm.authentication")}>
            <Select value={sftpAuthMethod} onValueChange={(v) => setSftpAuthMethod(v as "password" | "privateKey")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="password">{t("admin.newConnectionWizard.password")}</SelectItem>
                <SelectItem value="privateKey">{t("connectionForm.privateKey")}</SelectItem>
              </SelectContent>
            </Select>
          </F>
          {sftpAuthMethod === "password" ? (
            <F label={keepLabel(editing && editing.sftp?.hasPassword, t("admin.newConnectionWizard.password"))}>
              <Input
                type="password"
                value={sftpPassword}
                onChange={(e) => setSftpPassword(e.target.value)}
                placeholder={editing && editing.sftp?.hasPassword ? alreadySetMasked : t("admin.newConnectionWizard.password")}
                autoComplete="new-password"
              />
            </F>
          ) : (
            <>
              <F label={keepLabel(editing && editing.sftp?.hasPrivateKey, t("connectionForm.privateKey"))}>
                <textarea
                  className="min-h-[120px] rounded-md border border-input bg-background p-2 font-mono text-[11px]"
                  value={sftpPrivateKey}
                  onChange={(e) => setSftpPrivateKey(e.target.value)}
                  placeholder={editing && editing.sftp?.hasPrivateKey ? t("connectionForm.alreadySet") : "-----BEGIN OPENSSH PRIVATE KEY-----\n…"}
                  spellCheck={false}
                />
              </F>
              <F label={t("connectionForm.passphrase")}>
                <Input type="password" value={sftpPassphrase} onChange={(e) => setSftpPassphrase(e.target.value)} autoComplete="new-password" />
              </F>
            </>
          )}
          <div className="grid gap-2 rounded-md border border-dashed border-border/80 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("connectionForm.testConnection")}</p>
            <p className="text-xs text-muted-foreground">{t("connectionForm.sftpTestHint")}</p>
            <div>
              <Button
                size="sm" variant="outline" type="button" onClick={testSftp}
                disabled={
                  !sftpHost || !sftpUsername || !sftpRemotePath ||
                  (!editing && (sftpAuthMethod === "password" ? !sftpPassword : !sftpPrivateKey))
                }
              >
                <Play className="mr-1.5 h-4 w-4" /> {t("connectionForm.testConnection")}
              </Button>
            </div>
            <TestResult result={testResult} />
          </div>
        </>
      ) : kind === "engine" ? (
        <>
          <F label={t("connectionForm.engineUrl")}>
            <Input
              value={engineBaseUrl}
              onChange={(e) => setEngineBaseUrl(e.target.value)}
              placeholder="https://engine.example.com"
              spellCheck={false}
            />
          </F>
          <p className="text-xs text-muted-foreground">{t("connectionForm.engineUrlHelp")}</p>
          <F label={t("connectionForm.engineAudience")}>
            <Input
              value={engineAudience}
              onChange={(e) => setEngineAudience(e.target.value)}
              spellCheck={false}
            />
          </F>
          <p className="text-xs text-muted-foreground">{t("connectionForm.engineAudienceHelp")}</p>
        </>
      ) : kind === "snowflake" ? (
        <>
          <F label={t("connectionForm.sfAccount")}>
            <Input value={sfAccount} onChange={(e) => setSfAccount(e.target.value)} placeholder="xy12345.us-east-1" />
          </F>
          <div className="grid grid-cols-2 gap-3">
            <F label={t("connectors.usernameLabel")}>
              <Input value={sfUsername} onChange={(e) => setSfUsername(e.target.value)} placeholder="REPORT_READER" />
            </F>
            <F label={keepLabel(editing && editing.sf?.hasPassword, t("admin.newConnectionWizard.password"))}>
              <Input
                type="password"
                value={sfPassword}
                onChange={(e) => setSfPassword(e.target.value)}
                placeholder={editing && editing.sf?.hasPassword ? alreadySetMasked : t("connectionForm.sfPassword")}
                autoComplete="new-password"
              />
            </F>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <F label={t("connectionForm.warehouse")}>
              <Input value={sfWarehouse} onChange={(e) => setSfWarehouse(e.target.value)} placeholder="COMPUTE_WH" />
            </F>
            <F label={t("admin.newConnectionWizard.database")}>
              <Input value={sfDatabase} onChange={(e) => setSfDatabase(e.target.value)} placeholder="ANALYTICS" />
            </F>
            <F label={t("connectionForm.schemaDefault").replace("{value}", "PUBLIC")}>
              <Input value={sfSchema} onChange={(e) => setSfSchema(e.target.value)} placeholder="PUBLIC" />
            </F>
          </div>
          <F label={t("connectionForm.sfRole")}>
            <Input value={sfRole} onChange={(e) => setSfRole(e.target.value)} placeholder="SYSADMIN" />
          </F>
          <div className="grid gap-2 rounded-md border border-dashed border-border/80 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("connectionForm.testConnection")}</p>
            <p className="text-xs text-muted-foreground">
              {fill(t("connectionForm.sfTestHint"), {
                sql: SELECT_1,
                target: <span className="font-mono">{(sfDatabase || "DB").toUpperCase()}.{(sfSchema || "PUBLIC").toUpperCase()}</span>,
              })}
              {editing && sfPassword.length === 0 && editing.sf?.hasPassword ? ` ${t("connectionForm.usingStoredPassword")}` : ""}
            </p>
            <div>
              <Button
                size="sm" variant="outline" type="button" onClick={testSnowflake}
                disabled={!sfAccount || !sfUsername || !sfWarehouse || !sfDatabase || (!editing && !sfPassword)}
              >
                <Play className="mr-1.5 h-4 w-4" /> {t("connectionForm.testConnection")}
              </Button>
            </div>
            <TestResult result={testResult} />
          </div>
        </>
      ) : (
        <>
          <F label={t("connectionForm.sqlitePath")}>
            <Input value={connection} onChange={(e) => setConnection(e.target.value)} placeholder="C:\\\\path\\\\to\\\\warehouse.db" />
          </F>
          <div className="grid gap-2 rounded-md border border-dashed border-border/80 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("connectionForm.testConnection")}</p>
            <p className="text-xs text-muted-foreground">{fill(t("connectionForm.sqliteTestHint"), { sql: SELECT_1 })}</p>
            <div>
              <Button size="sm" variant="outline" onClick={testSqlite} disabled={!connection} type="button">
                <Play className="mr-1.5 h-4 w-4" /> {t("connectionForm.testConnection")}
              </Button>
            </div>
            <TestResult result={testResult} />
          </div>
        </>
      )}

      <div>
        <Button
          size="sm" onClick={submit}
          disabled={submitting || !name || !isConnectionKindValid(currentFields())}
        >
          <Plus className="mr-1.5 h-4 w-4" />
          {submitting ? t("common.saving") : editing ? t("action.saveChanges") : t("connections.addHeading")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Excel upload subform. One-shot: pick a file → POST multipart → preview the
 * parsed schema. The /api/data-sources/excel/upload endpoint handles the
 * persist on success, so this UI doesn't need a separate "Save" step.
 *
 * Limits (file size, rows, sheets) come back in the success response and are
 * surfaced inline with the preview so admins know what was capped.
 */
type ExcelImportSchema = {
  source: "excel";
  importedAt: string;
  originalFilename: string;
  fileSize: number;
  tables: Array<{
    name: string;
    originalSheetName: string;
    columns: Array<{ name: string; originalHeader: string; type: string; sample: unknown }>;
    rowCount: number;
  }>;
  warnings: string[];
};

function ExcelUploadForm({ onSaved, roleOptions, onRoleOptionsChange }: { onSaved: () => void; roleOptions: RoleOption[]; onRoleOptionsChange: (next: RoleOption[]) => void }) {
  const { push } = useToast();
  const { t } = useT();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [schema, setSchema] = useState<ExcelImportSchema | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [visibility, setVisibility] = useState<VisibilityWire>({ mode: "tenant" });
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function pick(f: File | null) {
    setFile(f);
    setSchema(null);
    if (f && !name) {
      // Default the connection name to the filename minus extension.
      setName(f.name.replace(/\.(xlsx|xlsm|xls)$/i, ""));
    }
  }

  async function upload() {
    if (!file) return;
    setBusy(true);
    setSchema(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (name.trim()) fd.append("name", name.trim());
      // Visibility goes on the multipart body as a flat string + repeated
      // role fields. The server reads "visibility" + "roles" entries.
      fd.append("visibility", visibility.mode);
      if (visibility.mode === "roles") {
        for (const r of visibility.roles) fd.append("roles", r);
      }
      const r = await fetch("/api/data-sources/excel/upload", { method: "POST", body: fd });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) {
        push({
          variant: "destructive",
          title: r.status === 402 ? t("connectionForm.planLimit") : t("common.uploadFailed"),
          description: json?.error ?? r.statusText,
        });
        return;
      }
      setSchema(json.schema as ExcelImportSchema);
      push({
        variant: "success",
        title: t("connectionForm.excelUploaded"),
        description: t("connectionForm.excelUploadedDesc")
          .replace("{n}", String(json.schema.tables.length))
          .replace("{plural}", json.schema.tables.length === 1 ? "" : "s")
          .replace("{name}", json.name),
      });
      // Refresh the parent list so the new connection appears immediately.
      onSaved();
      // Don't reset `file` so the user still sees the preview block.
      setName("");
    } catch (e: any) {
      push({ variant: "destructive", title: t("common.uploadFailed"), description: e?.message ?? t("ask.networkError") });
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setFile(null);
    setSchema(null);
    setName("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <div className="grid gap-3">
      {!schema && (
        <>
          <VisibilityPicker value={visibility} onChange={setVisibility} roleOptions={roleOptions} onRoleOptionsChange={onRoleOptionsChange} />
          <div
            className={`grid place-items-center rounded-lg border-2 border-dashed p-8 transition-colors ${
              dragOver ? "border-primary bg-primary/5" : "border-border bg-muted/20"
            }`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const dropped = e.dataTransfer.files?.[0];
              if (dropped) pick(dropped);
            }}
          >
            <FileSpreadsheet className="mb-2 h-8 w-8 text-muted-foreground" />
            {file ? (
              <div className="text-center">
                <div className="text-sm font-medium">{file.name}</div>
                <div className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</div>
                <button
                  type="button"
                  className="mt-1.5 text-xs text-primary underline-offset-2 hover:underline"
                  onClick={() => fileInputRef.current?.click()}
                >
                  {t("connectionForm.chooseDifferentFile")}
                </button>
              </div>
            ) : (
              <div className="text-center">
                <div className="text-sm">
                  {fill(t("connectionForm.dropHint"), {
                    ext: <span className="font-medium">.xlsx</span>,
                    choose: (
                      <button
                        type="button"
                        className="text-primary underline-offset-2 hover:underline"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        {t("connectionForm.chooseFile")}
                      </button>
                    ),
                  })}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{t("connectionForm.limits")}</div>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={(e) => pick(e.target.files?.[0] ?? null)}
            />
          </div>

          {file && (
            <>
              <F label={t("connectionForm.excelName")}>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={file.name.replace(/\.(xlsx|xlsm|xls)$/i, "")} />
              </F>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={upload} disabled={busy || !file}>
                  <Upload className="mr-1.5 h-4 w-4" />
                  {busy ? t("connectionForm.uploading") : t("connectionForm.uploadCreate")}
                </Button>
                <Button size="sm" variant="ghost" onClick={reset} disabled={busy}>
                  <CloseIcon className="mr-1.5 h-4 w-4" /> {t("action.cancel")}
                </Button>
              </div>
            </>
          )}
        </>
      )}

      {schema && (
        <div className="grid gap-3">
          <div className="rounded-md border border-success/40 bg-success/5 p-3 text-xs">
            <div className="mb-1 font-medium">
              {t("connectionForm.importedFrom")
                .replace("{n}", String(schema.tables.length))
                .replace("{plural}", schema.tables.length === 1 ? "" : "s")
                .replace("{file}", schema.originalFilename)}
            </div>
            <div className="text-muted-foreground">
              {t("connectionForm.importSummary")
                .replace("{rows}", schema.tables.reduce((s, tbl) => s + tbl.rowCount, 0).toLocaleString())
                .replace("{size}", (schema.fileSize / 1024).toFixed(1))
                .replace("{at}", new Date(schema.importedAt).toLocaleString())}
            </div>
          </div>

          {schema.warnings.length > 0 && (
            <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs ">
              <div className="mb-1 font-medium">{t("connectionForm.warnings")}</div>
              <ul className="ml-4 list-disc space-y-0.5 text-muted-foreground">
                {schema.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}

          {schema.tables.map((sheet) => (
            <div key={sheet.name} className="overflow-hidden rounded-md border bg-card">
              <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2">
                <div>
                  <div className="text-sm font-medium">{sheet.name}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {t("connectionForm.sheetSummary")
                      .replace("{sheet}", sheet.originalSheetName)
                      .replace("{rows}", sheet.rowCount.toLocaleString())
                      .replace("{rowsPlural}", sheet.rowCount === 1 ? "" : "s")
                      .replace("{cols}", String(sheet.columns.length))
                      .replace("{colsPlural}", sheet.columns.length === 1 ? "" : "s")}
                  </div>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/30 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-1.5 text-left font-medium">{t("tableDetail.colHeaderColumn")}</th>
                      <th className="px-3 py-1.5 text-left font-medium">{t("common.type")}</th>
                      <th className="px-3 py-1.5 text-left font-medium">{t("connectionForm.originalHeader")}</th>
                      <th className="px-3 py-1.5 text-left font-medium">{t("tableDetail.colHeaderSample")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sheet.columns.map((c) => (
                      <tr key={c.name} className="border-t">
                        <td className="px-3 py-1.5 font-mono">{c.name}</td>
                        <td className="px-3 py-1.5">
                          <span className="rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium">
                            {c.type}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-muted-foreground">{c.originalHeader}</td>
                        <td className="px-3 py-1.5 font-mono text-muted-foreground">
                          {c.sample == null ? "—" : truncate(JSON.stringify(c.sample), 40)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={reset}>{t("connectionForm.uploadAnother")}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/**
 * Three-mode visibility picker. The same component drops into both the
 * REST/SQLite ConnectionForm and the ExcelUploadForm, so the UX is identical
 * regardless of how the connection arrives.
 *
 *   ( ) Tenant      — every workspace member can use this source (default).
 *   ( ) Roles       — only users with one of the picked role slugs.
 *   ( ) Just me     — only the uploader. (No admin override; "Just me" is
 *                     the only mode where admins do NOT bypass — that's the
 *                     whole point.)
 */
function VisibilityPicker({
  value, onChange, roleOptions, onRoleOptionsChange,
}: {
  value: VisibilityWire;
  onChange: (v: VisibilityWire) => void;
  roleOptions: RoleOption[];
  onRoleOptionsChange: (next: RoleOption[]) => void;
}) {
  const { t } = useT();
  const mode = value.mode;
  const selectedRoles = value.mode === "roles" ? value.roles : [];

  function toggleRole(slug: string) {
    if (mode !== "roles") return;
    const set = new Set(selectedRoles);
    if (set.has(slug)) set.delete(slug); else set.add(slug);
    onChange({ mode: "roles", roles: Array.from(set) });
  }

  return (
    <div className="grid gap-2 rounded-md border border-dashed border-border/80 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("connections.visibilityHeader")}</p>

      <div className="grid gap-1.5 text-sm">
        <label className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-muted/40">
          <input
            type="radio" className="mt-1"
            checked={mode === "tenant"}
            onChange={() => onChange({ mode: "tenant" })}
          />
          <span className="flex-1">
            <span className="flex items-center gap-1.5 font-medium">
              <UsersIcon className="h-3.5 w-3.5" /> {t("dashboardsMgr.vis.tenantLabel")}
            </span>
            <span className="text-xs text-muted-foreground">{t("connectionForm.vis.tenantDesc")}</span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-muted/40">
          <input
            type="radio" className="mt-1"
            checked={mode === "roles"}
            onChange={() => onChange({ mode: "roles", roles: selectedRoles })}
          />
          <span className="flex-1">
            <span className="flex items-center gap-1.5 font-medium">
              <Lock className="h-3.5 w-3.5" /> {t("dashboardsMgr.vis.rolesLabel")}
            </span>
            <span className="text-xs text-muted-foreground">{t("connectionForm.vis.rolesDesc")}</span>
            {mode === "roles" && (
              <span className="mt-2 block">
                <InlineTagManager
                  options={roleOptions}
                  selected={selectedRoles}
                  onToggle={toggleRole}
                  onOptionsChange={onRoleOptionsChange}
                />
              </span>
            )}
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-muted/40">
          <input
            type="radio" className="mt-1"
            checked={mode === "owner_only"}
            onChange={() => onChange({ mode: "owner_only" })}
          />
          <span className="flex-1">
            <span className="flex items-center gap-1.5 font-medium">
              <UserIcon className="h-3.5 w-3.5" /> {t("dashboardsMgr.vis.justMe")}
            </span>
            <span className="text-xs text-muted-foreground">{t("connectionForm.vis.justMeDesc")}</span>
          </span>
        </label>
      </div>
    </div>
  );
}

/**
 * The box under every Test button. REST shows the HTTP status and method it
 * sent; the database and file connectors report timing and what they reached.
 */
function TestResult({ result, rest }: { result: TestResultState | null; rest?: boolean }) {
  const { t } = useT();
  if (!result) return null;
  if (result.pending) {
    return <div className="rounded-md border border-border bg-muted/30 p-2 text-xs text-muted-foreground">{t("connectionForm.testing")}</div>;
  }
  const verdict = t(result.ok ? "connectionForm.testOk" : "connectionForm.testFailed");
  const ms = result.durationMs != null ? `${result.durationMs}ms` : "";
  const headline = result.error
    ? t(rest ? "common.requestFailed" : "connectionForm.connectionFailed")
    : rest
      ? `${verdict} (${result.status}${ms ? `, ${ms}` : ""}) ${result.method ?? ""} ${result.url ?? ""}`
      : `${verdict}${ms ? ` (${ms})` : ""} ${result.url ?? ""}`;
  return (
    <div className={result.ok ? "rounded-md border border-success/40 bg-success/5 p-2 text-xs" : "rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs"}>
      <div className="mb-1 font-medium">{headline}</div>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-foreground/80">{result.error ?? result.preview ?? ""}</pre>
    </div>
  );
}

/** Splits a dictionary string on its {slot} placeholders and drops React nodes in; t() itself only handles text. */
function fill(template: string, slots: Record<string, React.ReactNode>): React.ReactNode {
  return template.split(/(\{\w+\})/).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    return <Fragment key={i}>{m && m[1] in slots ? slots[m[1]] : part}</Fragment>;
  });
}

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
