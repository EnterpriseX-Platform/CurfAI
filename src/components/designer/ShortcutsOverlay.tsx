"use client";
import { useEffect } from "react";
import { Keyboard, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/LocaleContext";

/**
 * Designer keyboard-shortcut cheatsheet. Mounted by DesignerShell, opened by
 * the `?` key (or via a button in the toolbar). Pure client-side; doesn't own
 * the actual key handlers — those live in DesignerShell — it just lists them.
 *
 * Update this list whenever a new shortcut is added in DesignerShell so the
 * cheatsheet doesn't drift. Labels, descriptions and pointer gestures are
 * lib/i18n/dict.ts keys; `keys` are literal key caps.
 */

type Shortcut = { keys?: string[]; gestureKey?: string; labelKey: string; descKey: string };

const SECTIONS: { titleKey: string; items: Shortcut[] }[] = [
  {
    titleKey: "shortcuts.section.editing",
    items: [
      { keys: ["⌘", "Z"], labelKey: "designerToolbar.undo", descKey: "shortcuts.undoDesc" },
      { keys: ["⌘", "⇧", "Z"], labelKey: "designerToolbar.redo", descKey: "shortcuts.redoDesc" },
      { keys: ["⌘", "Y"], labelKey: "shortcuts.redoAlt", descKey: "shortcuts.redoAltDesc" },
      { keys: ["⌘", "D"], labelKey: "shortcuts.duplicate", descKey: "shortcuts.duplicateDesc" },
      { keys: ["Del"], labelKey: "shortcuts.delete", descKey: "shortcuts.deleteDesc" },
      { keys: ["Esc"], labelKey: "shortcuts.deselect", descKey: "shortcuts.deselectDesc" },
    ],
  },
  {
    titleKey: "shortcuts.section.run",
    items: [
      { keys: ["⌘", "R"], labelKey: "shortcuts.refresh", descKey: "shortcuts.refreshDesc" },
      { keys: ["?"], labelKey: "shortcuts.show", descKey: "shortcuts.showDesc" },
    ],
  },
  {
    titleKey: "shortcuts.section.pointer",
    items: [
      { gestureKey: "shortcuts.gesture.dragHandle", labelKey: "shortcuts.move", descKey: "shortcuts.moveDesc" },
      { gestureKey: "shortcuts.gesture.clickBody", labelKey: "shortcuts.select", descKey: "shortcuts.selectDesc" },
      { gestureKey: "shortcuts.gesture.dragCorner", labelKey: "shortcuts.resize", descKey: "shortcuts.resizeDesc" },
    ],
  },
];

export function ShortcutsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useT();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const [closePre, closePost] = t("shortcuts.pressToClose").split("{key}");
  const [notePre, noteRest] = t("shortcuts.windowsNote").split("{cmd}");
  const [noteMid, notePost] = noteRest.split("{ctrl}");
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-[640px] max-w-[92vw] overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div className="flex items-center gap-2">
            <Keyboard className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">{t("shortcuts.title")}</h2>
            <span className="text-[11px] text-muted-foreground">{closePre}<Kbd>Esc</Kbd>{closePost}</span>
          </div>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onClose} aria-label={t("action.close")}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="grid max-h-[70vh] gap-5 overflow-y-auto p-5">
          {SECTIONS.map((section) => (
            <section key={section.titleKey}>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t(section.titleKey)}
              </h3>
              <div className="overflow-hidden rounded-md border border-border/60 bg-muted/30">
                {section.items.map((s, i) => (
                  <div
                    key={s.labelKey}
                    className={`grid grid-cols-[150px_1fr] items-center gap-3 px-3 py-2 ${
                      i > 0 ? "border-t border-border/60" : ""
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-1">
                      {(s.keys ?? [t(s.gestureKey!)]).map((k, idx) => (
                        <span key={idx} className="contents">
                          {idx > 0 && <span className="text-[10px] text-muted-foreground">+</span>}
                          <Kbd>{k}</Kbd>
                        </span>
                      ))}
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-foreground">{t(s.labelKey)}</div>
                      <div className="text-[11px] text-muted-foreground">{t(s.descKey)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
          <p className="px-1 text-[11px] text-muted-foreground">
            {notePre}<Kbd>⌘</Kbd>{noteMid}<Kbd>Ctrl</Kbd>{notePost}
          </p>
        </div>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[20px] items-center justify-center rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] font-medium text-foreground shadow-xs">
      {children}
    </kbd>
  );
}
