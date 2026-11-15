"use client";
/**
 * PanelSection — the collapsible, small-caps section heading the right-hand
 * inspector uses, shared by the block properties (PropertyPanel) and the
 * whole-report settings shown when no block is selected (ReportSettingsPanel).
 * A panel opens on what is edited most (a block's content, a report's display);
 * the other groups pass defaultOpen={false} and wait behind their heading.
 */
import { useState } from "react";
import { ChevronDown } from "lucide-react";

export function PanelSection({
  icon: Icon, label, children, defaultOpen = true,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="space-y-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        <Icon className="h-3 w-3" />
        <span>{label}</span>
        <ChevronDown className={`ml-auto h-3 w-3 transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && <div className="space-y-2.5">{children}</div>}
    </div>
  );
}
