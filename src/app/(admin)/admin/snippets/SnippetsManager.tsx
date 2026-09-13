"use client";
/**
 * SnippetsManager — admin UI for the snippet library.
 *
 * Two halves:
 *   - List of existing snippets (filterable by kind), with inline edit
 *   - Add-new form at the top (kind dropdown + name + body + tags)
 *
 * Saves via /api/snippets routes; optimistic-ish: refresh the local list
 * after each successful POST/PUT/DELETE.
 */
import { useMemo, useState } from "react";
import { Plus, Trash2, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useT } from "@/lib/i18n/LocaleContext";

type Snippet = {
  id: string;
  name: string;
  kind: "sql" | "rest_path" | "rest_body";
  body: string;
  description?: string | null;
  tags: string[];
  updatedAt: string;
};

function useKinds() {
  const { t } = useT();
  return [
    { slug: "sql",       label: t("admin.snippets.kindSqlLabel"),       hint: t("admin.snippets.kindSqlHint") },
    { slug: "rest_path", label: t("admin.snippets.kindRestPathLabel"),  hint: t("admin.snippets.kindRestPathHint") },
    { slug: "rest_body", label: t("admin.snippets.kindRestBodyLabel"),  hint: t("admin.snippets.kindRestBodyHint") },
  ] as const;
}

export function SnippetsManager({ initial }: { initial: Snippet[] }) {
  const { t } = useT();
  const KINDS = useKinds();
  const [items, setItems] = useState<Snippet[]>(initial);
  const [filter, setFilter] = useState<"all" | Snippet["kind"]>("all");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => filter === "all" ? items : items.filter((s) => s.kind === filter), [items, filter]);

  async function refetch() {
    const r = await fetch("/api/snippets", { credentials: "include" });
    const j = await r.json();
    setItems(j.items ?? []);
  }
  async function handleCreate(s: Omit<Snippet, "id" | "updatedAt">) {
    setError(null);
    const r = await fetch("/api/snippets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(s),
    });
    if (!r.ok) { setError((await r.json())?.error ?? t("admin.apps.saveFailed")); return false; }
    setAdding(false);
    await refetch();
    return true;
  }
  async function handleSave(id: string, patch: Partial<Snippet>) {
    setError(null);
    const r = await fetch(`/api/snippets/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(patch),
    });
    if (!r.ok) { setError((await r.json())?.error ?? t("admin.apps.saveFailed")); return; }
    await refetch();
  }
  async function handleDelete(id: string) {
    setError(null);
    const r = await fetch(`/api/snippets/${id}`, { method: "DELETE", credentials: "include" });
    if (!r.ok) { setError((await r.json())?.error ?? t("admin.activations.errorDeleteFailed")); return; }
    await refetch();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">{t("admin.snippets.filterLabel")}</Label>
          <Select value={filter} onValueChange={(v) => setFilter(v as any)}>
            <SelectTrigger className="h-8 w-[200px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("admin.snippets.allKinds")}</SelectItem>
              {KINDS.map((k) => <SelectItem key={k.slug} value={k.slug}>{k.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button size="sm" onClick={() => setAdding(true)} disabled={adding}>
          <Plus className="mr-1.5 h-3.5 w-3.5" /> {t("admin.snippets.newSnippet")}
        </Button>
      </div>

      {error && <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
      {adding && (
        <SnippetEditor
          initial={{ id: "", name: "", kind: "sql", body: "", description: "", tags: [], updatedAt: "" }}
          onSave={async (s) => { await handleCreate(s); }}
          onCancel={() => setAdding(false)}
          isNew
        />
      )}

      {filtered.length === 0 && (
        <p className="rounded-md border border-dashed border-border/60 bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
          {t("admin.snippets.emptyPrefix")} <span className="font-medium">{t("admin.snippets.newSnippet")}</span> {t("admin.snippets.emptySuffix")}
        </p>
      )}

      <div className="space-y-3">
        {filtered.map((s) => (
          <SnippetEditor
            key={s.id}
            initial={s}
            onSave={async (patch) => handleSave(s.id, patch)}
            onDelete={async () => handleDelete(s.id)}
          />
        ))}
      </div>
    </div>
  );
}

function SnippetEditor({
  initial, onSave, onDelete, onCancel, isNew = false,
}: {
  initial: Snippet;
  onSave: (s: Snippet) => Promise<void>;
  onDelete?: () => Promise<void>;
  onCancel?: () => void;
  isNew?: boolean;
}) {
  const { t } = useT();
  const KINDS = useKinds();
  const [draft, setDraft] = useState<Snippet>(initial);
  const [open, setOpen] = useState(isNew);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const kindMeta = KINDS.find((k) => k.slug === draft.kind)!;

  return (
    <div className="rounded-lg border border-border bg-background p-3">
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-start justify-between gap-3 text-left"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{draft.name}</span>
              <span className="rounded-full bg-muted px-1.5 py-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                {kindMeta.label}
              </span>
            </div>
            {draft.description && (
              <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{draft.description}</p>
            )}
          </div>
          <span className="text-[10px] text-muted-foreground">{shortDate(draft.updatedAt)}</span>
        </button>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-0.5">
              <Label className="text-[10px]">{t("common.name")}</Label>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="monthly_active_users"
                className="h-8 text-xs"
              />
            </div>
            <div className="grid gap-0.5">
              <Label className="text-[10px]">{t("admin.snippets.kindLabel")}</Label>
              <Select value={draft.kind} onValueChange={(v) => setDraft({ ...draft, kind: v as Snippet["kind"] })}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => <SelectItem key={k.slug} value={k.slug}>{k.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-0.5">
            <Label className="text-[10px]">{t("common.description")}</Label>
            <Input
              value={draft.description ?? ""}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder={t("admin.snippets.descriptionPlaceholder")}
              className="h-8 text-xs"
            />
          </div>
          <div className="grid gap-0.5">
            <Label className="text-[10px]">{t("admin.snippets.bodyLabel")}</Label>
            <textarea
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              className="min-h-[120px] rounded-md border border-input bg-background p-2 font-mono text-xs shadow-xs focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder={kindMeta.hint}
            />
            <p className="text-[10px] text-muted-foreground">{kindMeta.hint}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={!dirty} onClick={async () => { await onSave(draft); if (!isNew) setOpen(false); }}>
              <Save className="mr-1.5 h-3.5 w-3.5" /> {isNew ? t("admin.snippets.addSnippet") : t("action.save")}
            </Button>
            {onCancel && (
              <Button size="sm" variant="ghost" onClick={onCancel}>
                <X className="mr-1.5 h-3.5 w-3.5" /> {t("action.cancel")}
              </Button>
            )}
            {!isNew && onDelete && (
              <Button size="sm" variant="ghost" className="ml-auto text-destructive/80 hover:text-destructive" onClick={async () => {
                if (window.confirm(t("admin.snippets.confirmDelete").replace("{name}", draft.name))) await onDelete();
              }}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" /> {t("action.delete")}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function shortDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
