"use client";
import { useT } from "@/lib/i18n/LocaleContext";

/**
 * Day-first / month-first for one date column. Shown on every date column
 * so a wrong auto-detection is always correctable, and called out only
 * when the file itself proved nothing either way. Used by the upload
 * preview's column table and the standard-dataset mapping panel.
 */
export function DateOrderToggle({
  value, unproven, onChange,
}: {
  value: "mdy" | "dmy";
  unproven: boolean;
  onChange: (v: "mdy" | "dmy") => void;
}) {
  const { t } = useT();
  return (
    <div className="mt-1 flex items-center gap-1">
      {(["dmy", "mdy"] as const).map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          title={t(o === "dmy" ? "tables.preview.dmyTitle" : "tables.preview.mdyTitle")}
          className={
            "rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors " +
            (value === o
              ? "bg-primary-soft text-primary"
              : "text-muted-foreground hover:bg-muted")
          }
        >
          {t(o === "dmy" ? "tables.preview.dmy" : "tables.preview.mdy")}
        </button>
      ))}
      {unproven && (
        <span className="text-[10px] text-warning" title={t("tables.preview.dateUnprovenHint")}>
          {t("tables.preview.dateUnproven")}
        </span>
      )}
    </div>
  );
}
