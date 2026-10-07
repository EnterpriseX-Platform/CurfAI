/**
 * The "view" form of the engine admin console as plain data: what a guided edit holds, what each step checks,
 * the request the engine wants, and how the engine's refusals map back to a step. No React, no fetch.
 *
 * A view is a named SELECT plus a policy (who may query it, who sees personal data, row rules). The engine is
 * the authority on every rule; the checks here only save a round trip and say things in plain words. Messages
 * are i18n keys (engineAdmin.views.*), never English text.
 *
 * `public` is a reserved role: it offers the view to anonymous visitors of public report links. It is kept out
 * of the role lists on purpose and carried by one explicit flag (`isPublic`) that is only ever set by the admin
 * ticking it, so no other edit can switch it on.
 */
import type {
  ConnectionKind, EngineProblem, EngineView, Introspection, IntrospectedTable, PiiMode, RlsOperator,
} from "./adminClient";

export const PUBLIC_ROLE = "public";
export const BUILT_IN_ROLES = ["curf-admin", "curf-viewer"] as const;

export const VIEW_STEPS = ["source", "columns", "access", "rows", "public", "review"] as const;
export type ViewStep = (typeof VIEW_STEPS)[number];

export type ColumnForm = {
  name: string;
  type: string;
  label: string;
  description: string;
  pii: PiiMode;
  /** What the engine suggested when it first read this column; null when not known (an older view). */
  suggested: PiiMode | null;
};

export type RuleForm = { column: string; operator: RlsOperator; attribute: string };
export type ParamForm = { name: string; value: string };

export type ViewForm = {
  /** Set once the engine has a draft (after "read the columns", or when editing). */
  id?: string;
  version?: number;
  name: string;
  description: string;
  connectionId: string;
  sql: string;
  /** Values for `:name` parameters so the engine can check the columns. The engine does not hand these back. */
  sampleParams: ParamForm[];
  columns: ColumnForm[];
  allowedRoles: string[];
  piiRoles: string[];
  bypassRoles: string[];
  rlsRules: RuleForm[];
  /** Text so a half-typed number is not forced into a value. Blank = engine default. */
  refreshSeconds: string;
  /** Offers the view to anonymous visitors. Never on by default. */
  isPublic: boolean;
  /** The admin said they understand what a public view exposes. Needed to save a public view. */
  publicAck: boolean;
};

export function emptyViewForm(connectionId = "", sql = "", name = ""): ViewForm {
  return {
    name, description: "", connectionId, sql, sampleParams: [], columns: [], allowedRoles: [], piiRoles: [], bypassRoles: [],
    rlsRules: [], refreshSeconds: "", isPublic: false, publicAck: false,
  };
}

/** Splits `public` out of the role list into its own flag. */
export function fromView(v: EngineView): ViewForm {
  const allowed = v.allowedRoles ?? [];
  const isPublic = allowed.includes(PUBLIC_ROLE);
  return {
    id: v.id,
    version: v.version,
    name: v.name,
    description: v.description ?? "",
    connectionId: v.connectionId,
    sql: v.sql,
    sampleParams: [],
    columns: (v.columns ?? []).map((c) => ({ name: c.name, type: c.type, label: c.label ?? "", description: c.description ?? "", pii: c.pii, suggested: null })),
    allowedRoles: allowed.filter((r) => r !== PUBLIC_ROLE),
    piiRoles: (v.piiRoles ?? []).filter((r) => r !== PUBLIC_ROLE),
    bypassRoles: (v.bypassRoles ?? []).filter((r) => r !== PUBLIC_ROLE),
    rlsRules: (v.rlsRules ?? []).map((r) => ({ column: r.column, operator: r.operator, attribute: r.attribute })),
    refreshSeconds: v.refreshSeconds === null || v.refreshSeconds === undefined ? "" : String(v.refreshSeconds),
    isPublic,
    // Someone already made this decision; it is not asked again just to open the view.
    publicAck: isPublic,
  };
}

/**
 * The engine's answer after it read the columns: take its list, keep what the admin typed for columns that were
 * already there, and remember what it suggested for each new one. `version`/`id` move on to the saved draft.
 */
export function mergeSaved(form: ViewForm, saved: EngineView, opts: { keepChoices?: boolean } = {}): ViewForm {
  const before = new Map(form.columns.map((c) => [c.name, c]));
  return {
    ...form,
    id: saved.id,
    version: saved.version,
    columns: (saved.columns ?? []).map((c) => {
      const prev = before.get(c.name);
      return {
        name: c.name,
        type: c.type,
        label: c.label ?? prev?.label ?? "",
        description: c.description ?? prev?.description ?? "",
        // After the statement changed the engine re-read the columns without our overrides; a column that is still
        // there keeps what the admin chose for it.
        pii: opts.keepChoices && prev ? prev.pii : c.pii,
        suggested: prev ? prev.suggested : c.pii,
      };
    }),
  };
}

/** The same form with every column's mode as the engine suggested it (the engine's first guess). */
export function resetToSuggestions(form: ViewForm): ViewForm {
  return { ...form, columns: form.columns.map((c) => (c.suggested ? { ...c, pii: c.suggested } : c)) };
}

export function isPersonalLooking(c: ColumnForm): boolean {
  return c.suggested === "MASK" || c.suggested === "HIDE";
}

// ---- roles ---------------------------------------------------------------------------------------------------------

const ROLE = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}_.:-]{0,63}$/u;

export type RoleAdd = { roles: string[]; error?: "engineAdmin.views.err.roleShape" | "engineAdmin.views.err.rolePublic" };

/** Adds one role typed or picked by the admin. `public` is refused: it has its own step. Duplicates are ignored. */
export function addRole(roles: string[], input: string): RoleAdd {
  const role = input.trim();
  if (!role) return { roles };
  if (role.toLowerCase() === PUBLIC_ROLE) return { roles, error: "engineAdmin.views.err.rolePublic" };
  if (!ROLE.test(role)) return { roles, error: "engineAdmin.views.err.roleShape" };
  return { roles: roles.includes(role) ? roles : [...roles, role] };
}

export type RoleSuggestion = { value: string; label: string };

/** Curf's built-in roles first, then the workspace's own, without repeats or the reserved `public`. */
export function roleSuggestions(custom: { slug: string; label?: string }[]): RoleSuggestion[] {
  const out: RoleSuggestion[] = BUILT_IN_ROLES.map((r) => ({ value: r, label: r }));
  for (const c of custom) {
    if (!c.slug || c.slug.toLowerCase() === PUBLIC_ROLE || out.some((o) => o.value === c.slug)) continue;
    out.push({ value: c.slug, label: c.label && c.label !== c.slug ? `${c.label} (${c.slug})` : c.slug });
  }
  return out;
}

// ---- SQL helpers ---------------------------------------------------------------------------------------------------

function quote(kind: ConnectionKind, ident: string): string {
  if (kind === "MYSQL" || kind === "MARIADB") return `\`${ident.replace(/`/g, "``")}\``;
  if (kind === "SQLSERVER") return `[${ident.replace(/]/g, "]]")}]`;
  return `"${ident.replace(/"/g, '""')}"`;
}

/** A plain SELECT of every column of a table, with identifiers quoted the way the database wants. */
export function sqlForTable(kind: ConnectionKind, schema: string, table: IntrospectedTable): string {
  const cols = table.columns.length ? table.columns.map((c) => quote(kind, c.name)).join(",\n       ") : "*";
  const from = schema ? `${quote(kind, schema)}.${quote(kind, table.name)}` : quote(kind, table.name);
  return `SELECT ${cols}\nFROM ${from}`;
}

/** "customer_orders" -> "Customer orders". */
export function suggestViewName(table: string): string {
  const words = table.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

/** The `:name` parameters a statement uses (not `::casts`, not text inside quotes or comments), in order, once each. */
export function detectSqlParams(sql: string): string[] {
  const stripped = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
  const found: string[] = [];
  for (const m of stripped.matchAll(/(?<![:\w]):([A-Za-z_][A-Za-z0-9_]*)/g)) if (!found.includes(m[1])) found.push(m[1]);
  return found;
}

/** Sample values go to the engine as numbers or booleans when they are plainly one, otherwise as text ("007" stays text). */
export function coerceParam(value: string): string | number | boolean {
  const v = value.trim();
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(v)) return Number(v);
  if (v === "true") return true;
  if (v === "false") return false;
  return value;
}

/** Keeps the sample-parameter rows in line with the `:names` the statement uses; typed values stay. */
export function syncParams(sql: string, current: ParamForm[]): ParamForm[] {
  return detectSqlParams(sql).map((name) => current.find((p) => p.name === name) ?? { name, value: "" });
}

// ---- status ----------------------------------------------------------------------------------------------------------

export type ViewStatus = {
  /** The version viewers query, or null when unpublished. */
  published: number | null;
  /** The working copy has edits viewers do not see yet. */
  draftChanges: boolean;
  /** Anonymous visitors of public links can query it right now. */
  publicLive: boolean;
  /** The working copy offers it to the public, but it is not live (a draft, or a change not yet published). */
  publicPending: boolean;
};

export function viewStatus(v: Pick<EngineView, "version" | "publishedVersion" | "allowedRoles">): ViewStatus {
  const published = v.publishedVersion ?? null;
  const draftChanges = published !== null && v.version > published;
  const offered = (v.allowedRoles ?? []).includes(PUBLIC_ROLE);
  const publicLive = offered && published !== null && !draftChanges;
  return { published, draftChanges, publicLive, publicPending: offered && !publicLive };
}

export function filterViews<T extends Pick<EngineView, "name" | "description" | "connectionId">>(
  views: T[], query: string, connectionName: (id: string) => string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return views;
  return views.filter((v) => `${v.name} ${v.description ?? ""} ${connectionName(v.connectionId)}`.toLowerCase().includes(q));
}

// ---- checks ------------------------------------------------------------------------------------------------------------

export type ViewErrors = Record<string, string>;

const ATTRIBUTE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Why the view cannot be public yet, as codes the screen turns into sentences. */
export type PublicBlocker = "rowRules" | "personalColumns" | "piiRoles" | "bypassRoles";

export function publicBlockers(form: ViewForm): { code: PublicBlocker; columns?: string[] }[] {
  const out: { code: PublicBlocker; columns?: string[] }[] = [];
  if (form.rlsRules.length > 0) out.push({ code: "rowRules" });
  const exposed = form.columns.filter((c) => isPersonalLooking(c) && c.pii === "NONE").map((c) => c.name);
  if (exposed.length) out.push({ code: "personalColumns", columns: exposed });
  // The role lists cannot hold `public` from this form; kept so a view loaded with it is still reported.
  if (form.piiRoles.includes(PUBLIC_ROLE)) out.push({ code: "piiRoles" });
  if (form.bypassRoles.includes(PUBLIC_ROLE)) out.push({ code: "bypassRoles" });
  return out;
}

export function validateStep(form: ViewForm, step: ViewStep): ViewErrors {
  const e: ViewErrors = {};
  if (step === "source") {
    const name = form.name.trim();
    if (!name) e.name = "engineAdmin.views.err.nameRequired";
    else if (name.length > 100) e.name = "engineAdmin.views.err.nameLong";
    if (!form.connectionId) e.connectionId = "engineAdmin.views.err.connectionRequired";
    const sql = form.sql.trim();
    if (!sql) e.sql = "engineAdmin.views.err.sqlRequired";
    else if (!/^(select|with|\()/i.test(sql)) e.sql = "engineAdmin.views.err.sqlSelect";
    form.sampleParams.forEach((p, i) => {
      if (!p.name.trim()) e[`param.${i}.name`] = "engineAdmin.views.err.paramName";
    });
  }
  if (step === "columns" && form.columns.length === 0) e.columns = "engineAdmin.views.err.columnsNotRead";
  if (step === "access") {
    const r = form.refreshSeconds.trim();
    if (r !== "" && (!/^\d+$/.test(r) || Number(r) > 86400)) e.refreshSeconds = "engineAdmin.views.err.refresh";
  }
  if (step === "rows") {
    const seen = new Set<string>();
    const names = new Set(form.columns.map((c) => c.name));
    form.rlsRules.forEach((rule, i) => {
      if (!rule.column || !names.has(rule.column)) e[`rule.${i}.column`] = "engineAdmin.views.err.ruleColumn";
      if (!ATTRIBUTE.test(rule.attribute)) e[`rule.${i}.attribute`] = "engineAdmin.views.err.ruleAttribute";
      const key = `${rule.column}\u0000${rule.attribute}`;
      if (seen.has(key)) e[`rule.${i}.attribute`] = "engineAdmin.views.err.ruleDuplicate";
      seen.add(key);
    });
  }
  if (step === "public" && form.isPublic) {
    if (publicBlockers(form).length) e.public = "engineAdmin.views.err.publicBlocked";
    else if (!form.publicAck) e.publicAck = "engineAdmin.views.err.publicAck";
  }
  return e;
}

/** The first step with a problem, or null. */
export function firstInvalidStep(form: ViewForm): { step: ViewStep; errors: ViewErrors } | null {
  for (const step of VIEW_STEPS) {
    const errors = validateStep(form, step);
    if (Object.keys(errors).length) return { step, errors };
  }
  return null;
}

// ---- the request ---------------------------------------------------------------------------------------------------

/** The body for POST/PUT /views. `public` is added to the allowed roles only when the admin turned it on. */
export function toViewRequest(form: ViewForm, opts: { omitColumns?: boolean } = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: form.name.trim(),
    connectionId: form.connectionId,
    sql: form.sql.trim(),
    allowedRoles: form.isPublic ? [...form.allowedRoles, PUBLIC_ROLE] : [...form.allowedRoles],
    piiRoles: [...form.piiRoles],
    bypassRoles: [...form.bypassRoles],
    rlsRules: form.rlsRules.map((r) => ({ column: r.column, operator: r.operator, attribute: r.attribute })),
  };
  if (form.description.trim()) body.description = form.description.trim();
  if (form.columns.length && !opts.omitColumns) {
    body.columns = form.columns.map((c) => {
      const o: Record<string, unknown> = { name: c.name, pii: c.pii };
      if (c.label.trim()) o.label = c.label.trim();
      if (c.description.trim()) o.description = c.description.trim();
      return o;
    });
  }
  if (form.refreshSeconds.trim() !== "") body.refreshSeconds = Number(form.refreshSeconds.trim());
  const params = form.sampleParams.filter((p) => p.name.trim() && p.value !== "");
  if (params.length) body.sampleParams = Object.fromEntries(params.map((p) => [p.name.trim(), coerceParam(p.value)]));
  if (form.id && form.version !== undefined) body.version = form.version;
  return body;
}

/** For "is there anything unsaved": the form as it would be saved, plus what is only on screen. */
export function snapshot(form: ViewForm): string {
  return JSON.stringify({ r: toViewRequest(form), a: form.publicAck });
}

/** What the engine reads the columns from: when this changes, the draft must be saved again before the columns step. */
export function sourceKey(form: ViewForm): string {
  return JSON.stringify([form.connectionId, form.sql.trim(), form.sampleParams.filter((p) => p.value !== "").map((p) => [p.name, p.value])]);
}

export function isDirty(form: ViewForm, baseline: string): boolean {
  return snapshot(form) !== baseline;
}

// ---- the engine's refusals -----------------------------------------------------------------------------------------

export type RoutedProblem = {
  byStep: Partial<Record<ViewStep, string[]>>;
  /** Why the engine would not make the view public, verbatim, without the "public: " prefix. */
  publicRefusals: string[];
  /** Messages for fields this form has no place for. */
  general: string[];
};

export function stepForField(field: string): ViewStep | null {
  const f = field.replace(/[\[.].*$/, "");
  switch (f) {
    case "name": case "description": case "connectionId": case "sql": case "sampleParams": return "source";
    case "columns": return "columns";
    case "allowedRoles": case "piiRoles": case "bypassRoles": case "refreshSeconds": return "access";
    case "rlsRules": return "rows";
    default: return null;
  }
}

/** Sorts the engine's per-field messages into the step each belongs to; `public: ...` refusals go to the public step. */
export function routeProblem(problem: EngineProblem): RoutedProblem {
  const out: RoutedProblem = { byStep: {}, publicRefusals: [], general: [] };
  for (const [field, messages] of Object.entries(problem.fields)) {
    for (const message of messages) {
      const pub = /^public:\s*/i.exec(message);
      if (pub) { out.publicRefusals.push(message.slice(pub[0].length)); continue; }
      const step = stepForField(field);
      if (step) (out.byStep[step] ??= []).push(message);
      else out.general.push(message);
    }
  }
  if (Object.keys(problem.fields).length === 0 && problem.message) out.general.push(problem.message);
  return out;
}

/** The earliest step the problem touches, so the dialog can take the admin there. */
export function stepOfProblem(routed: RoutedProblem): ViewStep | null {
  if (routed.publicRefusals.length) return "public";
  return VIEW_STEPS.find((s) => (routed.byStep[s]?.length ?? 0) > 0) ?? null;
}

// ---- from a table (Databases -> Views) -----------------------------------------------------------------------------

export function tableRef(schema: string, table: string): string {
  return schema ? `${schema}.${table}` : table;
}

export function findTable(intro: Introspection, ref: string): { schema: string; table: IntrospectedTable } | null {
  for (const s of intro.schemas) {
    for (const t of s.tables) if (tableRef(s.name, t.name) === ref) return { schema: s.name, table: t };
  }
  return null;
}

export type Handoff = { connectionId: string; table: string | null };

/** The address of the Views tab that opens a new view on this connection (and table). */
export function viewsHandoffUrl(href: string, connectionId: string, table?: string): string {
  const url = new URL(href);
  url.search = "";
  url.searchParams.set("tab", "views");
  url.searchParams.set("fromConnection", connectionId);
  if (table) url.searchParams.set("table", table);
  return `${url.pathname}${url.search}`;
}

export function readHandoff(search: string): Handoff | null {
  const p = new URLSearchParams(search);
  const connectionId = p.get("fromConnection");
  if (!connectionId || !/^[0-9a-fA-F-]{36}$/.test(connectionId)) return null;
  const table = p.get("table");
  return { connectionId, table: table && table.length <= 300 ? table : null };
}

/** The address without the hand-off, so a refresh does not open the dialog again. */
export function withoutHandoff(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("fromConnection");
  url.searchParams.delete("table");
  return `${url.pathname}${url.search}`;
}

/** One cell of a preview, as text: never HTML, long values cut. */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
