"use client";
/**
 * Block cards in the dashboard manager: pick one block of a report as a card (lib/dashboards/slotKey.ts), and name a card
 * already picked. A report's blocks come from the report itself, as the signed-in editor may read them (a block gated to
 * roles they lack is not offered).
 */
import { useEffect, useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import { cardBlocks, blockLabel, parseSlotKey } from "@/lib/dashboards/slotKey";
import { useT } from "@/lib/i18n/LocaleContext";

export type CardBlock = { id: string; label: string; type: string };

const cache = new Map<string, Promise<CardBlock[]>>();

function loadCardBlocks(reportId: string): Promise<CardBlock[]> {
  let p = cache.get(reportId);
  if (!p) {
    p = fetch(`/api/reports/${reportId}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => cardBlocks(j?.definition).map((b) => ({ id: b.id, label: blockLabel(b), type: b.type })))
      .catch(() => []);
    // A failed read is not remembered, so opening the list again tries again.
    p.then((list) => { if (list.length === 0) cache.delete(reportId); });
    cache.set(reportId, p);
  }
  return p;
}

/** Under an available report: its blocks, each one a click away from being a card. */
export function BlockPicker({ reportId, taken, full, onAdd }: { reportId: string; taken: string[]; full: boolean; onAdd: (blockId: string) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [blocks, setBlocks] = useState<CardBlock[] | null>(null);
  useEffect(() => {
    if (!open || blocks) return;
    let live = true;
    void loadCardBlocks(reportId).then((b) => { if (live) setBlocks(b); });
    return () => { live = false; };
  }, [open, blocks, reportId]);

  return (
    <div className="border-b border-border/60 last:border-b-0">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-1 px-3 pb-1.5 pl-9 text-left text-2xs text-muted-foreground hover:text-foreground" aria-expanded={open} data-testid="pick-block-toggle">
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? "" : "-rotate-90"}`} /> {t("dashboardsMgr.pickBlock")}
      </button>
      {open && (
        <ul className="pb-1.5 pl-9 pr-3">
          {blocks === null && <li className="py-1 text-2xs text-muted-foreground">{t("dashboardsMgr.blocksLoading")}</li>}
          {blocks?.length === 0 && <li className="py-1 text-2xs italic text-muted-foreground">{t("dashboardsMgr.noBlocks")}</li>}
          {blocks?.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                disabled={full || taken.includes(`${reportId}#${b.id}`)}
                onClick={() => onAdd(b.id)}
                className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-muted/40 disabled:opacity-50"
              >
                <Plus className="h-3 w-3 text-muted-foreground" />
                <span className="flex-1 truncate">{b.label}</span>
                <span className="rounded-full border border-border bg-muted/40 px-1.5 text-2xs text-muted-foreground">{b.type}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A picked block card's name: the block's label and its report, once the report has been read. */
export function BlockCardName({ slotKey, reportName }: { slotKey: string; reportName: string | null }) {
  const { reportId, blockId } = parseSlotKey(slotKey);
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void loadCardBlocks(reportId).then((b) => { if (live) setLabel(b.find((x) => x.id === blockId)?.label ?? null); });
    return () => { live = false; };
  }, [reportId, blockId]);
  return <>{label ?? blockId}{reportName ? ` · ${reportName}` : ""}</>;
}
