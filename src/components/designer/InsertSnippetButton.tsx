"use client";
/**
 * InsertSnippetButton — small dropdown-anchored picker that pulls saved
 * snippets of the requested `kind` and calls `onInsert` with the chosen
 * body. Used inside the DataDrawer's SQL / REST path / REST body editors.
 *
 * The "insert" semantics are caller-controlled — the data drawer can
 * either replace the entire field (clean for a new query) or append at
 * the end (when iterating). We keep this component dumb: it returns the
 * body string to a callback and doesn't touch the editor itself.
 */
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Sparkles } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Snippet = {
  id: string;
  name: string;
  kind: "sql" | "rest_path" | "rest_body";
  body: string;
  description?: string | null;
  tags: string[];
};

export function InsertSnippetButton({
  kind, onInsert, label = "Insert snippet",
}: {
  kind: "sql" | "rest_path" | "rest_body";
  onInsert: (body: string) => void;
  label?: string;
}) {
  const [items, setItems] = useState<Snippet[] | null>(null);
  const [loading, setLoading] = useState(false);
  const fetchedRef = useRef(false);

  // Lazy load on first open — keeps this button cheap when the author
  // never opens the dropdown.
  function ensureLoaded() {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    setLoading(true);
    fetch(`/api/snippets?kind=${kind}`, { credentials: "include" })
      .then((r) => r.ok ? r.json() : { items: [] })
      .then((j) => setItems(j.items ?? []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }

  return (
    <DropdownMenu onOpenChange={(o) => o && ensureLoaded()}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Sparkles className="h-3 w-3" />
          {label}
          <ChevronDown className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[60vh] w-[320px] overflow-y-auto">
        {loading && (
          <div className="px-3 py-2 text-xs text-muted-foreground">Loading…</div>
        )}
        {items && items.length === 0 && (
          <div className="px-3 py-3 text-xs text-muted-foreground">
            No saved {kind.replace("_", " ")} snippets yet.
            <br />
            <a href="/admin/snippets" className="mt-2 inline-block text-primary underline">Manage snippets</a>
          </div>
        )}
        {items?.map((s) => (
          <DropdownMenuItem
            key={s.id}
            onClick={() => onInsert(s.body)}
            className="flex flex-col items-start gap-0.5"
          >
            <span className="text-sm font-medium">{s.name}</span>
            {s.description && (
              <span className="line-clamp-1 text-[10px] text-muted-foreground">{s.description}</span>
            )}
            <code className="mt-1 line-clamp-2 max-w-full whitespace-pre-wrap break-all rounded bg-muted px-1.5 py-1 text-[10px] text-muted-foreground/80">
              {s.body.slice(0, 120)}{s.body.length > 120 ? "…" : ""}
            </code>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
