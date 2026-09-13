"use client";
/**
 * LineConnectionManager — interactive bits for a `kind:"line"` connection
 * at /admin/connections/[id]/syncs. Sibling to SyncsManager.tsx rather
 * than a branch inside it: LINE is push-only (no SyncJob/SyncCursor), so
 * the job × object-cursor rendering model SyncsManager is built around
 * doesn't apply here — see lib/sync/connectors/line.ts's header comment.
 *
 * Two things a tenant needs to do:
 *   1. Paste the webhook URL into LINE Developers Console → Messaging API
 *      → Webhook URL, for live message ingestion.
 *   2. Optionally upload a historical chat export (.txt) with a group
 *      label, for backfill.
 *
 * Run history (from both sources) is server-rendered by page.tsx as
 * `initial.runs`; a successful upload calls router.refresh() to get fresh
 * data instead of a bespoke GET endpoint.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { CircleDot, Copy, Loader2, Upload, Check, AlertTriangle } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";

type Run = {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  rowsRead: number;
  rowsWritten: number;
  errorMessage: string | null;
};

type Initial = {
  connection: { id: string; kind: string; name: string; enabled: boolean; createdAt: string };
  webhookUrl: string;
  runs: Run[];
};

export function LineConnectionManager({ initial }: { initial: Initial }) {
  const { t } = useT();
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [groupId, setGroupId] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function copyWebhookUrl() {
    try {
      await navigator.clipboard.writeText(initial.webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard permission denied — no-op, URL is still selectable text */ }
  }

  async function upload() {
    if (!file || !groupId.trim()) return;
    setUploading(true);
    setUploadResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("groupId", groupId.trim());
      const res = await fetch(`/api/admin/connections/${initial.connection.id}/line-import`, {
        method: "POST",
        credentials: "include",
        body: form,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      setUploadResult({ ok: true, message: t("admin.lineConnection.importSuccess").replace("{n}", String(json.written)) });
      setFile(null);
      router.refresh();
    } catch (e: any) {
      setUploadResult({ ok: false, message: e?.message ?? t("admin.lineConnection.importFailed") });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold">{t("admin.lineConnection.webhookTitle")}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("admin.lineConnection.webhookHint")}</p>
        <div className="mt-3 flex items-center gap-2">
          <code className="flex-1 truncate rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            {initial.webhookUrl}
          </code>
          <button
            type="button"
            onClick={copyWebhookUrl}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-xs font-medium hover:bg-accent/30"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? t("admin.lineConnection.copied") : t("admin.lineConnection.copy")}
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold">{t("admin.lineConnection.importTitle")}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("admin.lineConnection.importHint")}</p>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto]">
          <div className="space-y-2">
            <input
              type="file"
              accept=".txt"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm"
            />
            <input
              type="text"
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              placeholder={t("admin.lineConnection.groupIdPlaceholder")}
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <button
            type="button"
            onClick={upload}
            disabled={uploading || !file || !groupId.trim()}
            className="inline-flex h-9 items-center gap-1.5 self-start rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {t("admin.lineConnection.importSubmit")}
          </button>
        </div>
        {uploadResult && (
          <div className={`mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
            uploadResult.ok ? "border-success/30 bg-success/10 text-success" : "border-destructive/30 bg-destructive/10 text-destructive"
          }`}>
            {uploadResult.ok ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            <span>{uploadResult.message}</span>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold">{t("admin.lineConnection.runsTitle")}</h2>
        {initial.runs.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">{t("admin.lineConnection.noRuns")}</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {initial.runs.map((r) => (
              <li key={r.id} className="flex items-center gap-3 rounded-md border border-border bg-muted/10 px-3 py-2 text-xs">
                <CircleDot className={`h-2.5 w-2.5 shrink-0 ${statusDot(r.status)}`} />
                <span className="w-36 shrink-0 text-muted-foreground">{new Date(r.startedAt).toLocaleString()}</span>
                <span className="font-medium">{r.rowsRead} → {r.rowsWritten}</span>
                {r.errorMessage && <span className="truncate text-destructive">{r.errorMessage}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function statusDot(status: string): string {
  switch (status) {
    case "ok":     return "text-success";
    case "failed": return "text-destructive";
    default:       return "text-muted-foreground/50";
  }
}
