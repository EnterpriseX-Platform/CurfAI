"use client";
/**
 * Shared "custom tags" chip picker used by every visibleToRoles editor
 * (Dashboard/DataSource/LakeTable visibility, per-block Report visibility).
 * Lets the caller toggle which tags apply AND manage the tenant-wide tag
 * catalog (create/delete) inline, instead of forcing a trip to /admin/roles.
 *
 * Deleting a tag here deletes the Role catalog row for the whole tenant
 * (same DELETE /api/admin/roles/[slug] endpoint /admin/roles uses) — it's
 * not scoped to "remove from this one item", hence the confirm.
 */
import { useState } from "react";
import { Plus, X as CloseIcon, Loader2 } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";

export type RoleTagOption = { slug: string; label: string };

export function InlineTagManager({
  options, selected, onToggle, onOptionsChange,
}: {
  options: RoleTagOption[];
  selected: string[];
  onToggle: (slug: string) => void;
  onOptionsChange: (next: RoleTagOption[]) => void;
}) {
  const { t } = useT();
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // slug being deleted, or "new" while creating
  const [error, setError] = useState<string | null>(null);

  async function createTag(e: React.FormEvent) {
    e.preventDefault();
    if (!newLabel.trim()) return;
    setBusy("new"); setError(null);
    const slug = newLabel.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    try {
      const res = await fetch("/api/admin/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, label: newLabel.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      onOptionsChange([...options, json.role].sort((a, b) => a.slug.localeCompare(b.slug)));
      onToggle(json.role.slug); // auto-select the freshly created tag for this item
      setNewLabel(""); setAdding(false);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  }

  async function deleteTag(slug: string) {
    if (!confirm(t("roleTags.confirmDelete").replace("{slug}", slug))) return;
    setBusy(slug);
    try {
      const res = await fetch(`/api/admin/roles/${slug}`, { method: "DELETE" });
      if (res.ok) onOptionsChange(options.filter((o) => o.slug !== slug));
    } finally { setBusy(null); }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {options.map((r) => {
        const on = selected.includes(r.slug);
        return (
          <span
            key={r.slug}
            className={`inline-flex items-center gap-1 rounded-full border pl-2.5 pr-1 py-0.5 text-xs transition-colors ${
              on ? "border-primary bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground hover:bg-muted/40"
            }`}
          >
            <button type="button" onClick={() => onToggle(r.slug)}>{r.label}</button>
            <button
              type="button"
              onClick={() => deleteTag(r.slug)}
              disabled={busy === r.slug}
              title={t("roleTags.deleteTag")}
              className="rounded-full p-0.5 opacity-50 hover:bg-destructive/10 hover:text-destructive hover:opacity-100"
            >
              {busy === r.slug ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <CloseIcon className="h-2.5 w-2.5" />}
            </button>
          </span>
        );
      })}
      {adding ? (
        <form onSubmit={createTag} className="flex items-center gap-1">
          <input
            autoFocus
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder={t("roleTags.newTagPlaceholder")}
            className="h-6 w-28 rounded-full border border-border bg-background px-2 text-xs outline-none focus:border-primary"
          />
          <button type="submit" disabled={busy === "new" || !newLabel.trim()} className="rounded-full border border-primary bg-primary/10 p-1 text-primary disabled:opacity-50">
            {busy === "new" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          </button>
          <button type="button" onClick={() => { setAdding(false); setNewLabel(""); }} className="rounded-full p-1 text-muted-foreground hover:bg-muted">
            <CloseIcon className="h-3 w-3" />
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-muted/40"
        >
          <Plus className="h-3 w-3" /> {t("roleTags.addTag")}
        </button>
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
