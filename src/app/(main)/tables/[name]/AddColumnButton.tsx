"use client";
/**
 * "Add column" on the table page's schema section — opens ColumnEditor, then
 * refreshes the page so the new column shows in the schema and the preview.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";
import { ColumnEditor, type EditorColumn } from "./ColumnEditor";

export function AddColumnButton({ tableName, columns }: { tableName: string; columns: EditorColumn[] }) {
  const { t } = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2.5 text-xs font-medium hover:bg-accent"
      >
        <Plus className="h-3.5 w-3.5" /> {t("colEditor.addColumn")}
      </button>
      <ColumnEditor tableName={tableName} columns={columns} open={open} onOpenChange={setOpen} onSaved={() => router.refresh()} />
    </>
  );
}
