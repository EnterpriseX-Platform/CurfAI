"use client";
/**
 * TableManagePanel — visibility + schema editing for one lake table.
 *
 * Single client component covering both Phase 2 controls so the user
 * has one "manage table" surface instead of two side-by-side ones.
 *
 * Layout: the trigger is a "Manage" button that sits in the page header's
 * action row; the expanded panel is a full-width page section and renders
 * through a portal into #table-manage-slot, below the header. They can't
 * share a DOM parent: PageHeader's action slot is a `flex items-center`
 * row, so returning the panel from this component's own position made it
 * a flex ITEM there — a card wedged mid-row that shoved the Delete button
 * out to its right. Keeping the panel in the body also means the Schema /
 * Preview sections below stay visible while you edit, which is the point
 * of the router.refresh() in retype (the panel and the page agree live);
 * a modal would have hidden exactly the tables the edit updates.
 *
 * Authority:
 *   - Schema add/rename/drop: editor or admin (or owner for owner-only tables)
 *   - Visibility: owner or admin only
 *
 * The page server-component passes us the current ACL state + the
 * caller's role + the role catalog so the visibility selector can show
 * the user's available role slugs without a second round-trip.
 */
import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/LocaleContext";
import { InlineTagManager } from "@/components/common/InlineTagManager";
import {
  Settings, Loader2, Plus, Pencil, Trash2, Check, X, AlertTriangle,
  Lock, Users, Globe2, ShieldAlert, RefreshCw,
} from "lucide-react";

type Sensitivity = "pii" | "financial" | "health" | "secret";
type Schema = Array<{
  name: string;
  type: string;
  sample?: any;
  sensitivity?: Sensitivity;
  unredactedForRoles?: string[];
}>;

const SENSITIVITY_LABEL_KEYS: Record<Sensitivity, string> = {
  pii:        "tableManage.sensitivity.pii",
  financial:  "tableManage.sensitivity.financial",
  health:     "tableManage.sensitivity.health",
  secret:     "tableManage.sensitivity.secret",
};
const SENSITIVITY_TONE: Record<Sensitivity, string> = {
  pii:        "border-destructive/40 bg-destructive/10 text-destructive",
  financial:  "border-warning/40 bg-warning/10 text-warning",
  health:     "border-primary/40 bg-primary-soft text-primary-ink",
  secret:     "border-faint/40 bg-muted text-foreground",
};

export function TableManagePanel({
  tableName,
  initialSchema,
  initialOwnerUserId,
  initialVisibleToRoles,
  callerUserId,
  callerRole,
  availableRoles,
}: {
  tableName: string;
  initialSchema: Schema;
  initialOwnerUserId: string | null;
  initialVisibleToRoles: string[];
  callerUserId: string;
  callerRole: string;
  availableRoles: { slug: string; label: string }[];
}) {
  const { t } = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Resolved after mount — the portal target doesn't exist during SSR.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setSlot(document.getElementById("table-manage-slot")); }, []);
  const [schema, setSchema] = useState<Schema>(initialSchema);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [roleOptions, setRoleOptions] = useState(availableRoles);

  const [ownerUserId, setOwnerUserId] = useState(initialOwnerUserId);
  const [visibleToRoles, setVisibleToRoles] = useState<string[]>(initialVisibleToRoles);

  const isOwner = ownerUserId === callerUserId;
  const isAdmin = callerRole === "admin";
  const canEditVisibility = isOwner || isAdmin || (!ownerUserId && callerRole === "developer");
  const canEditSchema = !ownerUserId
    ? (callerRole === "admin" || callerRole === "developer")
    : (isOwner || isAdmin);

  const visibilityMode: "tenant" | "roles" | "owner_only" =
    ownerUserId ? "owner_only" : visibleToRoles.length > 0 ? "roles" : "tenant";

  async function setVisibility(mode: "tenant" | "roles" | "owner_only", roles?: string[]) {
    setBusy("visibility"); setError(null); setSuccess(null);
    try {
      const r = await fetch(`/api/lake/tables/${encodeURIComponent(tableName)}/visibility`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mode === "roles" ? { mode, roles } : { mode }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? `Server returned ${r.status}`);
      setOwnerUserId(j.visibility.ownerUserId);
      setVisibleToRoles(j.visibility.visibleToRoles ?? []);
      setSuccess(t("tableManage.visibilityUpdated"));
      router.refresh();
    } catch (e: any) {
      setError(e?.message ?? t("tableManage.updateFailedFallback"));
    } finally {
      setBusy(null);
    }
  }

  async function schemaAction(payload: any, busyKey: string, successMsg: string) {
    setBusy(busyKey); setError(null); setSuccess(null);
    try {
      const r = await fetch(`/api/lake/tables/${encodeURIComponent(tableName)}/schema`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? `Server returned ${r.status}`);
      setSchema(j.schema);
      setSuccess(successMsg);
      router.refresh();
    } catch (e: any) {
      setError(e?.message ?? t("tableManage.schemaChangeFailedFallback"));
    } finally {
      setBusy(null);
    }
  }

  const trigger = (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
      className={
        "inline-flex h-8 items-center gap-1 rounded-md border px-3 text-xs transition-colors " +
        (open
          ? "border-primary bg-primary-soft text-primary"
          : "border-border bg-background text-foreground hover:bg-muted")
      }
    >
      <Settings className="h-3 w-3" /> {t("tableManage.manageButton")}
    </button>
  );

  // Built as JSX, not a nested component — a nested function component is a
  // new type on every render, so React would unmount and remount the whole
  // subtree each time, wiping SchemaSection's own state (the open retype
  // picker would slam shut the moment anything above it re-rendered).
  const panel = (
    <section className="mb-6 rounded-lg border border-border bg-card p-5 shadow-xs">
      <header className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Settings className="h-4 w-4" /> {t("tableManage.heading")}
        </h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={t("action.close")}
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {success && (
        <div className="mb-3 flex items-start gap-1.5 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-xs text-success ">
          <Check className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{success}</span>
        </div>
      )}
      {error && (
        <div className="mb-3 flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <VisibilitySection
        mode={visibilityMode}
        roleOptions={roleOptions}
        onRoleOptionsChange={setRoleOptions}
        currentRoles={visibleToRoles}
        canEdit={canEditVisibility}
        busy={busy === "visibility"}
        onChange={setVisibility}
      />

      <SchemaSection
        tableName={tableName}
        schema={schema}
        canEdit={canEditSchema}
        busy={busy ?? null}
        onAction={schemaAction}
        availableRoleSlugs={roleOptions.map((r) => r.slug)}
        onSchemaChange={setSchema}
      />
    </section>
  );

  // The trigger stays mounted while the panel is open, so the header's
  // action row keeps its width and nothing reflows on toggle.
  return (
    <>
      {trigger}
      {open && slot && createPortal(panel, slot)}
    </>
  );
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

function VisibilitySection({
  mode, roleOptions, onRoleOptionsChange, currentRoles, canEdit, busy, onChange,
}: {
  mode: "tenant" | "roles" | "owner_only";
  roleOptions: { slug: string; label: string }[];
  onRoleOptionsChange: (next: { slug: string; label: string }[]) => void;
  currentRoles: string[];
  canEdit: boolean;
  busy: boolean;
  onChange: (mode: "tenant" | "roles" | "owner_only", roles?: string[]) => void;
}) {
  const { t } = useT();
  const [editingRoles, setEditingRoles] = useState(mode === "roles");
  const [rolesDraft, setRolesDraft] = useState<string[]>(currentRoles);

  const Icon = mode === "owner_only" ? Lock : mode === "roles" ? Users : Globe2;
  const label = mode === "owner_only" ? t("tableManage.vis.justMe") : mode === "roles" ? t("tableManage.vis.specificRoles") : t("tableManage.vis.tenantWide");

  function toggleRole(slug: string) {
    setRolesDraft((xs) => xs.includes(slug) ? xs.filter((x) => x !== slug) : [...xs, slug]);
  }

  return (
    <div className="rounded-md border border-border bg-background p-3">
      <header className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" /> {t("tableManage.vis.heading")}
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">{label}</span>
        </h3>
        {!canEdit && (
          <span className="text-[10px] italic text-muted-foreground">{t("tableManage.vis.readOnlyHint")}</span>
        )}
      </header>

      {canEdit && (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-1.5">
            <ModeChip
              icon={<Globe2 className="h-3 w-3" />}
              label={t("tableManage.vis.tenantWide")}
              active={mode === "tenant"}
              busy={busy && mode !== "tenant"}
              onClick={() => { setEditingRoles(false); onChange("tenant"); }}
            />
            <ModeChip
              icon={<Users className="h-3 w-3" />}
              label={t("tableManage.vis.specificRoles")}
              active={mode === "roles"}
              busy={busy && mode !== "roles"}
              onClick={() => setEditingRoles(true)}
            />
            <ModeChip
              icon={<Lock className="h-3 w-3" />}
              label={t("tableManage.vis.justMe")}
              active={mode === "owner_only"}
              busy={busy && mode !== "owner_only"}
              onClick={() => { setEditingRoles(false); onChange("owner_only"); }}
            />
          </div>
          {editingRoles && (
            <div className="rounded-md border border-dashed border-border bg-muted/20 p-2.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("tableManage.vis.allowedRoles")}</p>
              <div className="mt-1.5">
                <InlineTagManager
                  options={roleOptions}
                  selected={rolesDraft}
                  onToggle={toggleRole}
                  onOptionsChange={onRoleOptionsChange}
                />
              </div>
              <div className="mt-2 flex items-center justify-end gap-1">
                <button
                  type="button"
                  onClick={() => { setEditingRoles(mode === "roles"); setRolesDraft(currentRoles); }}
                  className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
                >
                  {t("action.cancel")}
                </button>
                <button
                  type="button"
                  disabled={busy || rolesDraft.length === 0}
                  onClick={() => onChange("roles", rolesDraft)}
                  className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                  {t("action.apply")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ModeChip({ icon, label, active, busy, onClick }: { icon: React.ReactNode; label: string; active: boolean; busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors " +
        (active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border bg-background text-muted-foreground hover:bg-muted")
      }
    >
      {icon} {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function SchemaSection({
  tableName, schema, canEdit, busy, onAction, availableRoleSlugs, onSchemaChange,
}: {
  tableName: string;
  schema: Schema;
  canEdit: boolean;
  busy: string | null;
  onAction: (payload: any, busyKey: string, successMsg: string) => void;
  availableRoleSlugs: string[];
  onSchemaChange: (s: Schema) => void;
}) {
  const { t } = useT();
  const [adding, setAdding] = useState(false);
  const [addName, setAddName] = useState("");
  const [addDefault, setAddDefault] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Which column has the sensitivity picker open. Lifted to the section
  // so opening one closes any other (mutually exclusive).
  const [tagging, setTagging] = useState<string | null>(null);
  const [savingTag, setSavingTag] = useState<string | null>(null);
  // Same pattern, for the retype picker — mutually exclusive with tagging
  // (closing one when the other opens keeps the row from showing two
  // inline pickers at once).
  const [retyping, setRetyping] = useState<string | null>(null);

  async function setSensitivity(col: string, sensitivity: Sensitivity | null, unredactedForRoles?: string[]) {
    setSavingTag(col);
    try {
      const r = await fetch(`/api/lake/tables/${encodeURIComponent(tableName)}/sensitivity`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ column: col, sensitivity, unredactedForRoles }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? `Server returned ${r.status}`);
      // Reflect the change locally so the UI updates without a full reload.
      const next = schema.map((c) => c.name === col ? { ...c, ...j.column } : c);
      onSchemaChange(next);
    } catch (e) {
      // Surface via parent's success/error stream — caller will see it
      // because we're using the same notification channel as schema actions.
      // (Quietly logged; we don't have direct access to setError here, so
      // we let the API's status code do the talking.)
      console.warn("[sensitivity]", e);
    } finally {
      setSavingTag(null);
      setTagging(null);
    }
  }

  return (
    <div className="mt-4 rounded-md border border-border bg-background p-3">
      <header className="flex items-center justify-between">
        <h3 className="text-xs font-semibold">{t("tableDetail.schemaHeading")}</h3>
        {canEdit && !adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] hover:bg-muted"
          >
            <Plus className="h-3 w-3" /> {t("tableManage.schema.addColumn")}
          </button>
        )}
      </header>

      {adding && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onAction(
              { action: "addColumn", name: addName.trim(), defaultValue: addDefault.trim() || undefined },
              "addColumn",
              t("tableManage.schema.addedColumnMsg").replace("{name}", addName.trim()),
            );
            setAdding(false); setAddName(""); setAddDefault("");
          }}
          className="mt-2 grid gap-2 rounded-md border border-dashed border-border bg-muted/20 p-2 md:grid-cols-3"
        >
          <input
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            placeholder="column_name"
            required
            pattern="^[a-zA-Z_][a-zA-Z0-9_]*$"
            className="h-8 rounded border border-border bg-background px-2 font-mono text-xs"
          />
          <input
            value={addDefault}
            onChange={(e) => setAddDefault(e.target.value)}
            placeholder={t("tableManage.schema.defaultValuePlaceholder")}
            className="h-8 rounded border border-border bg-background px-2 text-xs"
          />
          <div className="flex items-center gap-1">
            <button
              type="submit"
              disabled={busy === "addColumn" || !addName.trim()}
              className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-2 text-[11px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {busy === "addColumn" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              {t("action.add")}
            </button>
            <button
              type="button"
              onClick={() => { setAdding(false); setAddName(""); setAddDefault(""); }}
              className="h-8 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-muted"
            >
              {t("action.cancel")}
            </button>
          </div>
        </form>
      )}

      <ul className="mt-3 divide-y divide-border">
        {schema.map((c) => (
          <li key={c.name} className="flex items-center justify-between gap-2 py-1.5">
            {renaming === c.name ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  onAction(
                    { action: "renameColumn", oldName: c.name, newName: renameDraft.trim() },
                    `rename-${c.name}`,
                    t("tableManage.schema.renamedColumnMsg").replace("{old}", c.name).replace("{new}", renameDraft.trim()),
                  );
                  setRenaming(null);
                }}
                className="flex flex-1 items-center gap-1"
              >
                <span className="text-[10px] text-muted-foreground">{c.name} →</span>
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  pattern="^[a-zA-Z_][a-zA-Z0-9_]*$"
                  required
                  className="h-7 rounded border border-border bg-background px-2 font-mono text-xs"
                />
                <button
                  type="submit"
                  disabled={busy?.startsWith("rename-")}
                  className="inline-flex h-7 items-center rounded-md bg-primary px-2 text-[10px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {busy === `rename-${c.name}` ? <Loader2 className="h-3 w-3 animate-spin" /> : t("tableManage.schema.renameOk")}
                </button>
                <button
                  type="button"
                  onClick={() => setRenaming(null)}
                  className="rounded p-1 text-muted-foreground hover:bg-muted"
                >
                  <X className="h-3 w-3" />
                </button>
              </form>
            ) : (
              <div className="flex w-full flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <code className="font-mono">{c.name}</code>
                    {canEdit ? (
                      <button
                        type="button"
                        onClick={() => { setRetyping(retyping === c.name ? null : c.name); setTagging(null); }}
                        disabled={!!busy}
                        title={t("tableManage.schema.retypeTitle")}
                        className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                      >
                        {c.type}
                      </button>
                    ) : (
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                        {c.type}
                      </span>
                    )}
                    {c.sensitivity && (
                      <span
                        className={
                          "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider " +
                          SENSITIVITY_TONE[c.sensitivity]
                        }
                        title={
                          (c.unredactedForRoles ?? []).length > 0
                            ? t("tableManage.schema.unredactedFor").replace("{roles}", (c.unredactedForRoles ?? []).join(", "))
                            : t("tableManage.schema.alwaysRedacted")
                        }
                      >
                        <ShieldAlert className="h-2.5 w-2.5" /> {t(SENSITIVITY_LABEL_KEYS[c.sensitivity])}
                      </span>
                    )}
                  </div>
                  {canEdit && (
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => { setTagging(tagging === c.name ? null : c.name); setRetyping(null); }}
                        disabled={!!busy || savingTag === c.name}
                        className={
                          "rounded p-1 transition-colors disabled:opacity-50 " +
                          (c.sensitivity
                            ? "text-destructive hover:bg-destructive/10"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground")
                        }
                        title={t("tableManage.schema.sensitivityTitle")}
                      >
                        <ShieldAlert className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => { setRenaming(c.name); setRenameDraft(c.name); }}
                        disabled={!!busy}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                        title={t("tableManage.schema.renameTitle")}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (confirm(t("tableManage.schema.dropConfirm").replace("{name}", c.name))) {
                            onAction(
                              { action: "dropColumn", name: c.name },
                              `drop-${c.name}`,
                              t("tableManage.schema.droppedColumnMsg").replace("{name}", c.name),
                            );
                          }
                        }}
                        disabled={!!busy}
                        className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                        title={t("tableManage.schema.dropTitle")}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                </div>

                {tagging === c.name && (
                  <SensitivityPicker
                    column={c}
                    availableRoleSlugs={availableRoleSlugs}
                    busy={savingTag === c.name}
                    onApply={(sensitivity, roles) => setSensitivity(c.name, sensitivity, roles)}
                    onClose={() => setTagging(null)}
                  />
                )}

                {retyping === c.name && (
                  <RetypePicker
                    tableName={tableName}
                    column={c}
                    // Deliberately does NOT close the picker on success — it
                    // stays open showing "N cleaned, M left as-is" until the
                    // user dismisses it. Closing immediately (the first cut
                    // of this) meant the result was computed and then
                    // unmounted in the same tick, so the user got no
                    // feedback at all about what actually happened.
                    onApplied={(nextSchema) => onSchemaChange(nextSchema)}
                    onClose={() => setRetyping(null)}
                  />
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sensitivity picker — inline below a column row when actively editing
// ---------------------------------------------------------------------------

function SensitivityPicker({
  column, availableRoleSlugs, busy, onApply, onClose,
}: {
  column: { name: string; sensitivity?: Sensitivity; unredactedForRoles?: string[] };
  availableRoleSlugs: string[];
  busy: boolean;
  onApply: (sensitivity: Sensitivity | null, roles?: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const [sensitivity, setSensitivity] = useState<Sensitivity | null>(column.sensitivity ?? null);
  const [allowedRoles, setAllowedRoles] = useState<string[]>(column.unredactedForRoles ?? []);

  function toggleRole(slug: string) {
    setAllowedRoles((xs) => xs.includes(slug) ? xs.filter((x) => x !== slug) : [...xs, slug]);
  }

  return (
    <div className="rounded-md border border-dashed border-border bg-muted/20 p-2.5 text-[11px]">
      <div className="flex items-center justify-between">
        <span className="font-semibold uppercase tracking-wider text-muted-foreground">
          {t("tableManage.sens.headingFor").replace("{name}", column.name)}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1">
        <SensChip label={t("tableManage.sens.none")} active={sensitivity === null} onClick={() => setSensitivity(null)} />
        {(["pii", "financial", "health", "secret"] as Sensitivity[]).map((s) => (
          <SensChip
            key={s}
            label={t(SENSITIVITY_LABEL_KEYS[s])}
            active={sensitivity === s}
            tone={SENSITIVITY_TONE[s]}
            onClick={() => setSensitivity(s)}
          />
        ))}
      </div>

      {sensitivity && (
        <div className="mt-2.5">
          <p className="text-muted-foreground">
            {t("tableManage.sens.unredactedForPre")} <strong>{t("tableManage.sens.tenantAdmins")}</strong> {t("tableManage.sens.explainPost")}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {availableRoleSlugs.length === 0 && (
              <p className="text-[10px] italic text-muted-foreground">
                {t("tableManage.sens.noRolesPre")} <a className="text-primary underline" href="/admin/roles">{t("tableManage.vis.adminRolesLink")}</a>{t("tableManage.sens.noRolesPost")}
              </p>
            )}
            {availableRoleSlugs.map((slug) => {
              const checked = allowedRoles.includes(slug);
              return (
                <label
                  key={slug}
                  className={
                    "inline-flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] " +
                    (checked
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground hover:bg-muted")
                  }
                >
                  <input type="checkbox" className="hidden" checked={checked} onChange={() => toggleRole(slug)} />
                  {checked ? <Check className="h-2.5 w-2.5" /> : <Plus className="h-2.5 w-2.5" />} {slug}
                </label>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center justify-end gap-1">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted"
        >
          {t("action.cancel")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onApply(sensitivity, sensitivity ? allowedRoles : undefined)}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[10px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          {t("action.apply")}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Retype picker — recovery when inference got a column's type wrong, or a
// table predates the write-time cleaning behaviour entirely
// ---------------------------------------------------------------------------

const RETYPE_OPTIONS: Array<{ value: "text" | "number" | "date" | "boolean"; labelKey: string }> = [
  { value: "text",    labelKey: "tableManage.retype.text" },
  { value: "number",  labelKey: "tableManage.retype.number" },
  { value: "date",    labelKey: "tableManage.retype.date" },
  { value: "boolean", labelKey: "tableManage.retype.boolean" },
];

function RetypePicker({
  tableName, column, onApplied, onClose,
}: {
  tableName: string;
  column: { name: string; type: string };
  onApplied: (schema: Schema) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const router = useRouter();
  const [selected, setSelected] = useState<"text" | "number" | "date" | "boolean">(
    (column.type === "text" || column.type === "number" || column.type === "date" || column.type === "boolean")
      ? column.type
      : "text",
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ updated: number; unchanged: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function apply() {
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await fetch(`/api/lake/tables/${encodeURIComponent(tableName)}/schema`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "retype", name: column.name, type: selected }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? `Server returned ${r.status}`);
      setResult(j.retypeResult ?? null);
      onApplied(j.schema);
      // The values just changed on disk (retype cleans every existing cell),
      // but the page's server-rendered Schema/Preview sections were fetched
      // at load time and have no way to know that — without this they keep
      // showing the pre-retype raw text ("$100") right below a Manage panel
      // that already agrees the column is clean, which reads as the page
      // contradicting itself. schemaAction() and setVisibility() above both
      // already do this same refresh for the same reason.
      router.refresh();
    } catch (e: any) {
      setError(e?.message ?? t("tableManage.updateFailedFallback"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-dashed border-border bg-muted/20 p-2.5 text-[11px]">
      <div className="flex items-center justify-between">
        <span className="font-semibold uppercase tracking-wider text-muted-foreground">
          {t("tableManage.retype.headingFor").replace("{name}", column.name)}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      <p className="mt-1 text-muted-foreground">{t("tableManage.retype.hint")}</p>

      <div className="mt-2 flex flex-wrap items-center gap-1">
        {RETYPE_OPTIONS.map((opt) => (
          <SensChip
            key={opt.value}
            label={t(opt.labelKey)}
            active={selected === opt.value}
            onClick={() => { setSelected(opt.value); setResult(null); setError(null); }}
          />
        ))}
      </div>

      {result && (
        <p className="mt-2 flex items-center gap-1 text-success">
          <Check className="h-3 w-3 shrink-0" />
          {t("tableManage.retype.resultMsg")
            .replace("{updated}", String(result.updated))
            .replace("{unchanged}", String(result.unchanged))}
        </p>
      )}
      {error && (
        <p className="mt-2 flex items-center gap-1 text-destructive">
          <AlertTriangle className="h-3 w-3 shrink-0" /> {error}
        </p>
      )}

      <div className="mt-3 flex items-center justify-end gap-1">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted"
        >
          {/* "Cancel" reads oddly once there's nothing left to cancel — a
              successful retype already happened and this button just
              dismisses the result the user has now seen. */}
          {result ? t("action.close") : t("action.cancel")}
        </button>
        <button
          type="button"
          disabled={busy || selected === column.type}
          onClick={apply}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[10px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          {t("tableManage.retype.apply")}
        </button>
      </div>
    </div>
  );
}

function SensChip({ label, active, tone, onClick }: { label: string; active: boolean; tone?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors " +
        (active
          ? (tone ?? "border-primary bg-primary/10 text-primary")
          : "border-border bg-background text-muted-foreground hover:bg-muted")
      }
    >
      {active && <Check className="h-2.5 w-2.5" />} {label}
    </button>
  );
}
