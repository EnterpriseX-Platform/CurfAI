"use client";
import { useState } from "react";
import { Plus, Trash2, Loader2, Pencil, Check, X as CloseIcon } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Role = { id: string; slug: string; label: string; description: string | null };

export function RolesManager({ initialRoles }: { initialRoles: Role[] }) {
  const { t } = useT();
  const [roles, setRoles] = useState(initialRoles);
  const [slug, setSlug] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editBusy, setEditBusy] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      const res = await fetch("/api/admin/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, label, description }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? t("schedules.createFailed"));
      setRoles((xs) => [...xs, json.role].sort((a, b) => a.slug.localeCompare(b.slug)));
      setSlug(""); setLabel(""); setDescription("");
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function remove(s: string) {
    if (!confirm(t("admin.roles.confirmDelete").replace("{slug}", s))) return;
    const res = await fetch(`/api/admin/roles/${s}`, { method: "DELETE" });
    if (res.ok) setRoles((xs) => xs.filter((r) => r.slug !== s));
  }

  function startEdit(r: Role) {
    setEditingSlug(r.slug);
    setEditLabel(r.label);
    setEditDescription(r.description ?? "");
  }

  async function saveEdit(s: string) {
    setEditBusy(true);
    try {
      const res = await fetch(`/api/admin/roles/${s}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: editLabel, description: editDescription }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? t("schedules.createFailed"));
      setRoles((xs) => xs.map((r) => (r.slug === s ? json.role : r)));
      setEditingSlug(null);
    } catch (e: any) { setError(e.message); }
    finally { setEditBusy(false); }
  }

  return (
    <div className="space-y-8">
      <form onSubmit={create} className="grid gap-3 rounded-lg border bg-card p-5 shadow-xs md:grid-cols-[1fr_1fr_2fr_auto]">
        <Input placeholder={t("admin.roles.slugPlaceholder")} value={slug} onChange={(e) => setSlug(e.target.value)} required />
        <Input placeholder={t("admin.roles.labelField")} value={label} onChange={(e) => setLabel(e.target.value)} required />
        <Input placeholder={t("admin.activations.form.descriptionOptional")} value={description} onChange={(e) => setDescription(e.target.value)} />
        <Button type="submit" disabled={busy || !slug || !label}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Plus className="mr-1.5 h-4 w-4" /> {t("action.add")}</>}
        </Button>
        {error && <div className="md:col-span-4 text-xs text-destructive">{error}</div>}
      </form>

      <div className="overflow-x-auto rounded-lg border bg-card shadow-xs">
        <table className="w-full text-sm">
          <thead className="bg-muted text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium">{t("admin.roles.slugHeader")}</th>
              <th className="px-4 py-2.5 text-left font-medium">{t("admin.roles.labelField")}</th>
              <th className="px-4 py-2.5 text-left font-medium">{t("common.description")}</th>
              <th className="w-24" />
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => {
              const isEditing = editingSlug === r.slug;
              return (
                <tr key={r.id} className="border-t">
                  <td className="px-4 py-2.5 font-mono text-xs">{r.slug}</td>
                  <td className="px-4 py-2.5 font-medium">
                    {isEditing ? (
                      <Input value={editLabel} onChange={(e) => setEditLabel(e.target.value)} className="h-7 text-sm" />
                    ) : r.label}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {isEditing ? (
                      <Input value={editDescription} onChange={(e) => setEditDescription(e.target.value)} className="h-7 text-xs" />
                    ) : (r.description ?? "")}
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center justify-end gap-1">
                      {isEditing ? (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => saveEdit(r.slug)} disabled={editBusy || !editLabel.trim()} title={t("action.save")}>
                            {editBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingSlug(null)} disabled={editBusy} title={t("action.cancel")}>
                            <CloseIcon className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => startEdit(r)} title={t("action.edit")}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => remove(r.slug)} title={t("action.delete")}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {roles.length === 0 && (
              <tr><td colSpan={4} className="p-10 text-center text-xs text-muted-foreground">{t("admin.roles.empty")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
