"use client";
/**
 * SavedViewsPicker — viewer-side dropdown that mounts inside the FilterBar.
 *
 * UX shape:
 *   - Default chip: "Views" with the active view's name appended when one
 *     is selected, e.g. "Views: EMEA Q4". Clicking opens a menu split into
 *     Public (workspace-shared) and Private (mine).
 *   - Bottom of the menu: "Save current view…" opens a small popover form;
 *     "Manage views…" toggles inline edit/delete affordances.
 *   - Selecting a view fires `onApply(params)` and `onSelectView(id)` — the
 *     parent owns the URL sync (?view=<id> is stamped into the address bar).
 *
 * Save flow: prompts for name + visibility (Just me / Workspace) and POSTs
 * to /api/reports/[id]/views. On success it shows up at the top of the
 * appropriate group.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark, BookmarkPlus, Check, Globe2, Lock, Pencil, Trash2, Users, X, Loader2,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, DropdownMenuSeparator,
  DropdownMenuLabel, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useT } from "@/lib/i18n/LocaleContext";

export type SavedView = {
  id: string;
  name: string;
  description?: string | null;
  isPublic: boolean;
  mine: boolean;
  params: Record<string, unknown>;
  updatedAt?: string;
};

type Props = {
  reportId: string;
  /** The currently active view id, if one is selected. */
  activeViewId?: string | null;
  /** Current filter values — what "Save current view" snapshots. */
  currentParams: Record<string, unknown>;
  /** Set when the user picks a saved view; null clears the selection. */
  onSelectView: (id: string | null) => void;
  /** Apply param values (mirrors FilterBar's own onApply). */
  onApply: (params: Record<string, unknown>) => void;
};

export function SavedViewsPicker({
  reportId, activeViewId, currentParams, onSelectView, onApply,
}: Props) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [views, setViews] = useState<SavedView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSave, setShowSave] = useState(false);
  const [manageMode, setManageMode] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/reports/${reportId}/views`, { credentials: "include" });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? t("savedViews.loadFailed"));
      setViews(j.items ?? []);
    } catch (e: any) {
      setError(e?.message ?? t("ask.networkError"));
    } finally {
      setLoading(false);
    }
  }, [reportId, t]);

  // Lazy-load when the menu first opens. Avoids a round-trip on every page load.
  useEffect(() => { if (open && views === null) void refresh(); }, [open, views, refresh]);

  const active = useMemo(
    () => (views ?? []).find((v) => v.id === activeViewId) ?? null,
    [views, activeViewId],
  );

  // Group views: public first, then private. Sorted by updatedAt desc within each.
  const grouped = useMemo(() => {
    const list = views ?? [];
    return {
      shared: list.filter((v) => v.isPublic),
      mine: list.filter((v) => !v.isPublic),
    };
  }, [views]);

  function applyView(v: SavedView) {
    onSelectView(v.id);
    onApply(v.params ?? {});
    setOpen(false);
  }

  function clearView() {
    onSelectView(null);
    setOpen(false);
  }

  async function deleteView(v: SavedView) {
    if (!confirm(t("savedViews.confirmDelete").replace("{name}", v.name))) return;
    const r = await fetch(`/api/reports/${reportId}/views/${v.id}`, {
      method: "DELETE", credentials: "include",
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(j?.error ?? t("savedViews.deleteFailed"));
      return;
    }
    if (activeViewId === v.id) onSelectView(null);
    void refresh();
  }

  async function renameView(v: SavedView, name: string) {
    const r = await fetch(`/api/reports/${reportId}/views/${v.id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(j?.error ?? t("savedViews.renameFailed"));
      return;
    }
    void refresh();
  }

  // Chip label adapts to whether a saved view is currently active.
  const chipBase =
    "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors";
  const chipClass = active
    ? chipBase + " border-primary/40 bg-primary/10 text-primary"
    : chipBase + " border-border bg-background text-muted-foreground hover:bg-muted";

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button type="button" className={chipClass} title={t("savedViews.title")}>
            <Bookmark className="h-3 w-3 opacity-60" />
            <span className="text-muted-foreground">{t("savedViews.viewLabel")}</span>
            <span className="max-w-[12ch] truncate">{active?.name ?? "—"}</span>
            <span className="text-[10px] opacity-50">▾</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72 p-1">
          {loading && (
            <div className="flex items-center justify-center gap-2 px-3 py-4 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> {t("savedViews.loading")}
            </div>
          )}
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          {!loading && !error && (
            <>
              {grouped.shared.length > 0 && (
                <>
                  <DropdownMenuLabel className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <Users className="h-3 w-3" /> {t("savedViews.sharedWithWorkspace")}
                  </DropdownMenuLabel>
                  {grouped.shared.map((v) => (
                    <ViewRow
                      key={v.id}
                      view={v}
                      active={activeViewId === v.id}
                      manageMode={manageMode}
                      onApply={() => applyView(v)}
                      onDelete={() => deleteView(v)}
                      onRename={(n) => renameView(v, n)}
                    />
                  ))}
                </>
              )}

              {grouped.mine.length > 0 && (
                <>
                  {grouped.shared.length > 0 && <DropdownMenuSeparator className="my-1" />}
                  <DropdownMenuLabel className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <Lock className="h-3 w-3" /> {t("savedViews.privateToMe")}
                  </DropdownMenuLabel>
                  {grouped.mine.map((v) => (
                    <ViewRow
                      key={v.id}
                      view={v}
                      active={activeViewId === v.id}
                      manageMode={manageMode}
                      onApply={() => applyView(v)}
                      onDelete={() => deleteView(v)}
                      onRename={(n) => renameView(v, n)}
                    />
                  ))}
                </>
              )}

              {grouped.shared.length === 0 && grouped.mine.length === 0 && (
                <div className="px-3 py-3 text-center text-xs text-muted-foreground">
                  {t("savedViews.empty")}<br />
                  <span className="text-muted-foreground/80">{t("savedViews.emptyHint")}</span>
                </div>
              )}

              <DropdownMenuSeparator className="my-1" />
              {active && (
                <DropdownMenuItem
                  onSelect={(e) => { e.preventDefault(); clearView(); }}
                  className="text-xs text-muted-foreground"
                >
                  <X className="mr-2 h-3.5 w-3.5" /> {t("savedViews.clearActiveView")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={(e) => { e.preventDefault(); setOpen(false); setShowSave(true); }}
                className="text-xs font-medium text-primary"
              >
                <BookmarkPlus className="mr-2 h-3.5 w-3.5" /> {t("savedViews.saveCurrentView")}
              </DropdownMenuItem>
              {(grouped.shared.length > 0 || grouped.mine.length > 0) && (
                <DropdownMenuItem
                  onSelect={(e) => { e.preventDefault(); setManageMode((m) => !m); }}
                  className="text-xs text-muted-foreground"
                >
                  <Pencil className="mr-2 h-3.5 w-3.5" />
                  {manageMode ? t("savedViews.doneManaging") : t("savedViews.manageViews")}
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {showSave && (
        <SaveViewDialog
          reportId={reportId}
          currentParams={currentParams}
          onClose={() => setShowSave(false)}
          onSaved={(v) => {
            setShowSave(false);
            // Insert the new view at the top of its group and select it.
            setViews((prev) => prev ? [v, ...prev.filter((x) => x.id !== v.id)] : [v]);
            onSelectView(v.id);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Per-view row, with optional inline manage controls
// ---------------------------------------------------------------------------

function ViewRow({
  view, active, manageMode, onApply, onDelete, onRename,
}: {
  view: SavedView;
  active: boolean;
  manageMode: boolean;
  onApply: () => void;
  onDelete: () => void;
  onRename: (n: string) => void;
}) {
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(view.name);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  if (editing) {
    return (
      <div className="flex items-center gap-1.5 rounded-md px-2 py-1.5">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { onRename(draft.trim() || view.name); setEditing(false); }
            if (e.key === "Escape") { setDraft(view.name); setEditing(false); }
          }}
          className="h-7 flex-1 rounded border border-border bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="button"
          onClick={() => { onRename(draft.trim() || view.name); setEditing(false); }}
          className="rounded p-1 text-success hover:bg-success/10"
          title={t("action.save")}
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => { setDraft(view.name); setEditing(false); }}
          className="rounded p-1 text-muted-foreground hover:bg-muted"
          title={t("action.cancel")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div
      className={
        "group relative flex items-center gap-2 rounded-md px-2 py-1.5 text-xs " +
        (active ? "bg-primary/10 text-primary" : "hover:bg-muted")
      }
    >
      <button
        type="button"
        onClick={onApply}
        className="flex flex-1 items-center gap-1.5 truncate text-left"
      >
        {view.isPublic ? (
          <Globe2 className="h-3 w-3 opacity-60" />
        ) : (
          <Lock className="h-3 w-3 opacity-60" />
        )}
        <span className="truncate font-medium">{view.name}</span>
        {active && <Check className="ml-auto h-3 w-3 text-primary" />}
      </button>
      {manageMode && view.mine && (
        <div className="ml-1 flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
            title={t("savedViews.rename")}
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title={t("action.delete")}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Save-current-view dialog
// ---------------------------------------------------------------------------

function SaveViewDialog({
  reportId, currentParams, onClose, onSaved,
}: {
  reportId: string;
  currentParams: Record<string, unknown>;
  onClose: () => void;
  onSaved: (view: SavedView) => void;
}) {
  const { t } = useT();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Esc to dismiss; cheap shortcut for a tiny modal.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !saving) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) { setError(t("savedViews.nameRequired")); return; }
    setSaving(true); setError(null);
    try {
      const r = await fetch(`/api/reports/${reportId}/views`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: trimmed,
          description: description.trim() || undefined,
          params: serializeParams(currentParams),
          isPublic,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? t("savedViews.saveFailed"));
      onSaved({
        id: j.view.id,
        name: j.view.name,
        description: j.view.description ?? null,
        isPublic: !!j.view.isPublic,
        mine: true,
        params: j.view.params ?? {},
        updatedAt: j.view.updatedAt,
      });
    } catch (e: any) {
      setError(e?.message ?? t("savedViews.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[calc(100%-2rem)] max-w-sm overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <BookmarkPlus className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold leading-tight">{t("savedViews.saveViewTitle")}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("savedViews.saveViewSubtitle")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t("action.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("common.name")}</span>
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("savedViews.namePlaceholder")}
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("common.description")} {t("common.optional")}</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("savedViews.descriptionPlaceholder")}
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>

          <fieldset className="rounded-md border border-border p-2">
            <legend className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("savedViews.visibility")}
            </legend>
            <label className="flex cursor-pointer items-start gap-2 rounded p-1.5 hover:bg-muted">
              <input
                type="radio"
                checked={!isPublic}
                onChange={() => setIsPublic(false)}
                className="mt-1 accent-primary"
              />
              <span className="flex-1">
                <span className="flex items-center gap-1.5 text-sm font-medium"><Lock className="h-3.5 w-3.5" /> {t("savedViews.justMe")}</span>
                <span className="block text-[11px] text-muted-foreground">{t("savedViews.justMeDesc")}</span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 rounded p-1.5 hover:bg-muted">
              <input
                type="radio"
                checked={isPublic}
                onChange={() => setIsPublic(true)}
                className="mt-1 accent-primary"
              />
              <span className="flex-1">
                <span className="flex items-center gap-1.5 text-sm font-medium"><Globe2 className="h-3.5 w-3.5" /> {t("savedViews.workspace")}</span>
                <span className="block text-[11px] text-muted-foreground">{t("savedViews.workspaceDesc")}</span>
              </span>
            </label>
          </fieldset>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="h-8 rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {t("action.cancel")}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || !name.trim()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Bookmark className="h-3 w-3" />}
            {t("savedViews.saveViewTitle")}
          </button>
        </div>
      </div>
    </div>
  );
}

// Strip undefined values; coerce non-primitives to strings so the JSON stays
// flat. Matches the schema accepted by the POST endpoint.
function serializeParams(p: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v as any;
    } else {
      out[k] = String(v);
    }
  }
  return out;
}
