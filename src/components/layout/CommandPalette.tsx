"use client";
/**
 * CommandPalette — the app-wide "/" search. Type to jump straight to a
 * report, lake table, materialized view, saved view, or connection (the
 * same tenant-scoped GET /api/v1/catalog/search the /catalog page uses),
 * or press Enter with the "Ask Curf" row active to hand the whole query
 * to the workspace-wide Ask page instead of searching titles.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Search, Loader2, Sparkles, Database, Cog, FileBarChart, Bookmark, Plug, CornerDownLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/LocaleContext";

type CatalogKind = "lake_table" | "mv" | "report" | "saved_view" | "connection";

type CatalogResult = {
  id: string;
  kind: CatalogKind;
  name: string;
  description: string | null;
  href: string;
};

// Same icon/label mapping as CatalogBrowser — kept local since each side
// only needs 5 short entries, not worth a shared module for.
const KIND_LABEL_KEYS: Record<CatalogKind, string> = {
  lake_table: "catalog.kind.lakeTables",
  mv: "materializedViews.heading",
  report: "nav.reports",
  saved_view: "catalog.kind.savedViews",
  connection: "nav.connections",
};

const KIND_ICON: Record<CatalogKind, typeof Database> = {
  lake_table: Database,
  mv: Cog,
  report: FileBarChart,
  saved_view: Bookmark,
  connection: Plug,
};

export type LocalPaletteItem = { id: string; label: string; hint?: string; onSelect: () => void };

export function CommandPalette({
  open, onClose, localItems = [], onAsk, askLabel,
}: {
  open: boolean;
  onClose: () => void;
  /**
   * D5 — app-local jump targets ("Jump to Claims"), rendered above catalog
   * results and included in the same keyboard navigation. Only the app
   * viewer passes these (its own tabs); every other mount of this palette
   * omits the prop and behaves exactly as it always has.
   */
  localItems?: LocalPaletteItem[];
  /**
   * Phase 12 (uplift) — when set, the bottom "Ask Curf" row calls this
   * with the typed query instead of navigating to /ask. The app viewer
   * passes its own ⌘K Ask palette's opener here, since that's now the
   * better destination for a typed question inside an app; every other
   * mount (AppShell's workspace-wide palette) omits this and keeps
   * today's /ask navigation exactly as it was.
   */
  onAsk?: (query: string) => void;
  /** Overrides the row's own label copy; omitted keeps the default
   *  "Ask Curf: '{query}'" text. */
  askLabel?: string;
}) {
  const { t } = useT();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CatalogResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setResults([]);
    setActiveIndex(0);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) { setResults([]); setLoading(false); return; }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/v1/catalog/search?q=${encodeURIComponent(q)}&limit=8`, { credentials: "include" });
        const j = await r.json().catch(() => null);
        setResults(Array.isArray(j?.results) ? j.results : []);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, open]);

  useEffect(() => { setActiveIndex(0); }, [results, query]);

  // Local items are always browsable (no query needed — the point is a
  // fast jump), and narrow down by a simple label match once typing
  // starts, the same "above catalog results" ordering throughout.
  const q = query.trim().toLowerCase();
  const filteredLocal = q ? localItems.filter((li) => li.label.toLowerCase().includes(q)) : localItems;
  const localCount = filteredLocal.length;
  const askRowIndex = query.trim() ? localCount + results.length : -1;
  const rowCount = localCount + results.length + (askRowIndex >= 0 ? 1 : 0);

  function activate(index: number) {
    if (index < 0 || index >= rowCount) return;
    onClose();
    if (index < localCount) {
      filteredLocal[index].onSelect();
    } else if (index === askRowIndex) {
      if (onAsk) onAsk(query.trim());
      else router.push(`/ask?q=${encodeURIComponent(query.trim())}`);
    } else {
      router.push(results[index - localCount].href);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIndex((i) => Math.min(i + 1, rowCount - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter") { e.preventDefault(); activate(activeIndex); return; }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[12vh]">
      <button
        type="button"
        aria-label={t("action.cancel")}
        onClick={onClose}
        className="fixed inset-0 bg-foreground/30 backdrop-blur-[1px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        onKeyDown={onKeyDown}
        className="relative z-10 w-full max-w-xl overflow-hidden rounded-xl border border-border bg-card shadow-lg"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("nav.askPlaceholder")}
            className="h-12 w-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-faint"
          />
          {loading && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
          <kbd className="hidden shrink-0 rounded-sm border border-border bg-muted px-1.5 py-px font-mono text-[11px] text-faint sm:inline-block">esc</kbd>
        </div>

        <div className="max-h-[50vh] overflow-y-auto py-1.5">
          {localCount === 0 && results.length === 0 && !loading && !query.trim() && (
            <p className="px-4 py-3 text-sm text-muted-foreground">{t("commandPalette.hint")}</p>
          )}
          {localCount === 0 && results.length === 0 && !loading && query.trim() && (
            <p className="px-4 py-3 text-sm text-muted-foreground">{t("catalog.noMatchesQuery")}</p>
          )}

          {filteredLocal.map((li, i) => {
            const active = i === activeIndex;
            return (
              <button
                key={`local-${li.id}`}
                type="button"
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => activate(i)}
                className={cn(
                  "flex w-full items-center gap-3 px-4 py-2 text-left text-sm",
                  active ? "bg-muted" : "hover:bg-muted/60",
                )}
              >
                <CornerDownLeft className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-foreground">{li.label}</span>
                  {li.hint && <span className="block truncate text-xs text-muted-foreground">{li.hint}</span>}
                </span>
              </button>
            );
          })}

          {results.map((r, i) => {
            const Icon = KIND_ICON[r.kind];
            const active = (i + localCount) === activeIndex;
            return (
              <button
                key={`${r.kind}-${r.id}`}
                type="button"
                onMouseEnter={() => setActiveIndex(i + localCount)}
                onClick={() => activate(i + localCount)}
                className={cn(
                  "flex w-full items-center gap-3 px-4 py-2 text-left text-sm",
                  active ? "bg-muted" : "hover:bg-muted/60",
                )}
              >
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-foreground">{r.name}</span>
                  {r.description && (
                    <span className="block truncate text-xs text-muted-foreground">{r.description}</span>
                  )}
                </span>
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  {t(KIND_LABEL_KEYS[r.kind])}
                </span>
              </button>
            );
          })}

          {askRowIndex >= 0 && (
            <button
              type="button"
              onMouseEnter={() => setActiveIndex(askRowIndex)}
              onClick={() => activate(askRowIndex)}
              className={cn(
                "flex w-full items-center gap-3 border-t border-border px-4 py-2.5 text-left text-sm",
                activeIndex === askRowIndex ? "bg-muted" : "hover:bg-muted/60",
              )}
            >
              <Sparkles className="h-4 w-4 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate">
                {askLabel ?? t("commandPalette.askAction").replace("{query}", query.trim())}
              </span>
              <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-faint" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
