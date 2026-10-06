"use client";
/**
 * Who can see a resource — everyone in the workspace, specific roles, or
 * just me — the one control for every resource on the canSeeDataSource
 * model (lake tables, Knowledge Centre documents). The caller owns the save.
 */
import { useState } from "react";
import { Check, Globe2, Loader2, Lock, Users } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";
import { InlineTagManager } from "@/components/common/InlineTagManager";


export function VisibilitySection({
  mode, roleOptions, onRoleOptionsChange, currentRoles, canEdit, busy, onChange,
}: {
  mode: "tenant" | "roles" | "owner_only";
  roleOptions: { slug: string; label: string }[];
  onRoleOptionsChange: (next: { slug: string; label: string }[]) => void;
  currentRoles: string[];
  canEdit: boolean;
  busy: boolean;
  onChange: (mode: "tenant" | "roles" | "owner_only", roles?: string[]) => void;
}) {
  const { t } = useT();
  const [editingRoles, setEditingRoles] = useState(mode === "roles");
  const [rolesDraft, setRolesDraft] = useState<string[]>(currentRoles);

  const Icon = mode === "owner_only" ? Lock : mode === "roles" ? Users : Globe2;
  const label = mode === "owner_only" ? t("tableManage.vis.justMe") : mode === "roles" ? t("tableManage.vis.specificRoles") : t("tableManage.vis.tenantWide");

  function toggleRole(slug: string) {
    setRolesDraft((xs) => xs.includes(slug) ? xs.filter((x) => x !== slug) : [...xs, slug]);
  }

  return (
    <div className="rounded-md border border-border bg-background p-3">
      <header className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" /> {t("tableManage.vis.heading")}
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">{label}</span>
        </h3>
        {!canEdit && (
          <span className="text-[10px] italic text-muted-foreground">{t("tableManage.vis.readOnlyHint")}</span>
        )}
      </header>

      {canEdit && (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-1.5">
            <ModeChip
              icon={<Globe2 className="h-3 w-3" />}
              label={t("tableManage.vis.tenantWide")}
              active={mode === "tenant"}
              busy={busy && mode !== "tenant"}
              onClick={() => { setEditingRoles(false); onChange("tenant"); }}
            />
            <ModeChip
              icon={<Users className="h-3 w-3" />}
              label={t("tableManage.vis.specificRoles")}
              active={mode === "roles"}
              busy={busy && mode !== "roles"}
              onClick={() => setEditingRoles(true)}
            />
            <ModeChip
              icon={<Lock className="h-3 w-3" />}
              label={t("tableManage.vis.justMe")}
              active={mode === "owner_only"}
              busy={busy && mode !== "owner_only"}
              onClick={() => { setEditingRoles(false); onChange("owner_only"); }}
            />
          </div>
          {editingRoles && (
            <div className="rounded-md border border-dashed border-border bg-muted/20 p-2.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("tableManage.vis.allowedRoles")}</p>
              <div className="mt-1.5">
                <InlineTagManager
                  options={roleOptions}
                  selected={rolesDraft}
                  onToggle={toggleRole}
                  onOptionsChange={onRoleOptionsChange}
                />
              </div>
              <div className="mt-2 flex items-center justify-end gap-1">
                <button
                  type="button"
                  onClick={() => { setEditingRoles(mode === "roles"); setRolesDraft(currentRoles); }}
                  className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
                >
                  {t("action.cancel")}
                </button>
                <button
                  type="button"
                  disabled={busy || rolesDraft.length === 0}
                  onClick={() => onChange("roles", rolesDraft)}
                  className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                  {t("action.apply")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ModeChip({ icon, label, active, busy, onClick }: { icon: React.ReactNode; label: string; active: boolean; busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors " +
        (active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border bg-background text-muted-foreground hover:bg-muted")
      }
    >
      {icon} {label}
    </button>
  );
}
