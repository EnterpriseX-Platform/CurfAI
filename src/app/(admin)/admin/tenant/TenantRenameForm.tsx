"use client";
import { useState } from "react";
import { Save, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useToast } from "@/lib/toast";

/**
 * Inline rename form for the current tenant. Slug is displayed but disabled -
 * see the page-level note explaining why we don't let admins change it.
 */
export function TenantRenameForm({ initial }: { initial: { id: string; name: string; slug: string } }) {
  const { push } = useToast();
  const [name, setName] = useState(initial.name);
  const [saving, setSaving] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim() === initial.name) return;
    setSaving(true);
    try {
      const r = await fetch("/api/admin/tenant", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!r.ok) {
        const msg = await r.text().catch(() => "Save failed");
        push({ variant: "destructive", title: "Rename failed", description: msg });
        return;
      }
      push({ variant: "success", title: "Tenant renamed" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
      <div className="grid gap-1.5">
        <Label htmlFor="name">Display name</Label>
        <Input id="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="slug">Slug</Label>
        <Input id="slug" value={initial.slug} disabled className="font-mono text-sm" />
      </div>
      <div className="flex items-end">
        <Button type="submit" size="sm" disabled={saving || name.trim() === initial.name}>
          {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
          Save
        </Button>
      </div>
    </form>
  );
}
