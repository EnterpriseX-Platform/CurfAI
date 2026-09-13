"use client";
/**
 * Tenant SMTP panel — email transport settings for this workspace.
 *
 * Production deploys configure email here instead of hardcoding SMTP_*
 * env vars. The password is write-only: after save the UI only shows a
 * "password saved" pill; leaving the field blank on later saves keeps it.
 */
import { useEffect, useState } from "react";
import { Loader2, Mail, CheckCircle2, AlertCircle, Eye, EyeOff, Trash2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/lib/toast";
import { useT } from "@/lib/i18n/LocaleContext";

type Status = {
  configured: boolean;
  host: string | null;
  port: number | null;
  secure: boolean;
  user: string | null;
  hasPassword: boolean;
  from: string | null;
  fallbackEnv: boolean;
};

export function SmtpPanel() {
  const { push } = useToast();
  const { t } = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [testing, setTesting] = useState(false);

  const [host, setHost] = useState("");
  const [port, setPort] = useState("587");
  const [secure, setSecure] = useState(false);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [from, setFrom] = useState("");
  const [testTo, setTestTo] = useState("");

  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/tenant/smtp");
      const j: Status = await r.json();
      setStatus(j);
      setHost(j.host ?? "");
      setPort(String(j.port ?? 587));
      setSecure(j.secure);
      setUser(j.user ?? "");
      setFrom(j.from ?? "");
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function save() {
    setSaving(true);
    try {
      const r = await fetch("/api/admin/tenant/smtp", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: host.trim(),
          port: Number(port) || 587,
          secure,
          user: user.trim() || null,
          password: password || null, // blank keeps the saved one
          from: from.trim() || null,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? t("admin.smtp.saveFailed"));
      push({ title: t("admin.smtp.savedToast"), variant: "success" });
      setPassword("");
      await load();
    } catch (e: any) {
      push({ title: e?.message ?? t("admin.smtp.saveFailed"), variant: "destructive" });
    } finally { setSaving(false); }
  }

  async function remove() {
    setRemoving(true);
    try {
      const r = await fetch("/api/admin/tenant/smtp", { method: "DELETE" });
      if (!r.ok) throw new Error(t("admin.smtp.removeFailed"));
      push({ title: t("admin.smtp.removedToast"), variant: "success" });
      setHost(""); setUser(""); setPassword(""); setFrom(""); setPort("587"); setSecure(false);
      await load();
    } catch (e: any) {
      push({ title: e?.message ?? t("admin.smtp.removeFailed"), variant: "destructive" });
    } finally { setRemoving(false); }
  }

  async function sendTest() {
    setTesting(true);
    try {
      const r = await fetch("/api/admin/tenant/smtp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: testTo.trim() }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j?.error ?? t("admin.smtp.testFailed"));
      push({ title: t("admin.smtp.testSentToast").replace("{email}", testTo.trim()), variant: "success" });
    } catch (e: any) {
      push({ title: e?.message ?? t("admin.smtp.testFailed"), variant: "destructive" });
    } finally { setTesting(false); }
  }

  return (
    <section className="mb-8 rounded-lg border bg-card p-5 shadow-xs">
      <div className="mb-1 flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("admin.smtp.title")}
        </p>
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : status?.configured ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2.5 py-0.5 text-[11px] font-medium text-success">
            <CheckCircle2 className="h-3 w-3" /> {t("admin.smtp.configured")}
          </span>
        ) : status?.fallbackEnv ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2.5 py-0.5 text-[11px] font-medium text-warning">
            <AlertCircle className="h-3 w-3" /> {t("admin.smtp.fallbackEnv")}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
            <AlertCircle className="h-3 w-3" /> {t("admin.smtp.notConfigured")}
          </span>
        )}
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        {t("admin.smtp.description")}
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2 grid grid-cols-[1fr_110px_auto] items-end gap-3">
          <div>
            <Label htmlFor="smtp-host" className="text-xs">{t("admin.smtp.hostLabel")}</Label>
            <Input id="smtp-host" value={host} onChange={(e) => setHost(e.target.value)}
              placeholder="smtp.office365.com" className="mt-1" />
          </div>
          <div>
            <Label htmlFor="smtp-port" className="text-xs">{t("admin.smtp.portLabel")}</Label>
            <Input id="smtp-port" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
              placeholder="587" inputMode="numeric" className="mt-1" />
          </div>
          <label className="mb-2 flex select-none items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} />
            {t("admin.smtp.tlsLabel")}
          </label>
        </div>

        <div>
          <Label htmlFor="smtp-user" className="text-xs">{t("admin.smtp.usernameLabel")} <span className="text-muted-foreground">{t("common.optional")}</span></Label>
          <Input id="smtp-user" value={user} onChange={(e) => setUser(e.target.value)}
            placeholder="alerts@company.com" autoComplete="off" className="mt-1" />
        </div>
        <div>
          <Label htmlFor="smtp-pass" className="text-xs">
            {t("admin.smtp.passwordLabel")}{" "}
            <span className="text-muted-foreground">
              {status?.hasPassword ? t("admin.smtp.passwordSavedHint") : t("common.optional")}
            </span>
          </Label>
          <div className="relative mt-1">
            <Input id="smtp-pass" type={showPassword ? "text" : "password"} value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={status?.hasPassword ? "••••••••" : t("admin.smtp.passwordPlaceholder")}
              autoComplete="new-password" className="pr-9" />
            <button type="button" onClick={() => setShowPassword((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={showPassword ? t("admin.smtp.hidePassword") : t("admin.smtp.showPassword")}>
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <div className="sm:col-span-2">
          <Label htmlFor="smtp-from" className="text-xs">{t("admin.smtp.fromLabel")}</Label>
          <Input id="smtp-from" value={from} onChange={(e) => setFrom(e.target.value)}
            placeholder='Curf Reports <reports@company.com>' className="mt-1" />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={save} disabled={saving || !host.trim()}>
          {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Mail className="mr-1.5 h-3.5 w-3.5" />}
          {t("admin.smtp.saveButton")}
        </Button>
        {status?.configured && (
          <Button size="sm" variant="ghost" onClick={remove} disabled={removing}
            className="text-destructive hover:text-destructive">
            {removing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1.5 h-3.5 w-3.5" />}
            {t("action.remove")}
          </Button>
        )}
      </div>

      <div className="mt-4 flex items-end gap-2 border-t pt-4">
        <div className="flex-1">
          <Label htmlFor="smtp-test-to" className="text-xs">{t("admin.smtp.testToLabel")}</Label>
          <Input id="smtp-test-to" value={testTo} onChange={(e) => setTestTo(e.target.value)}
            placeholder="you@company.com" className="mt-1" />
        </div>
        <Button size="sm" variant="outline" onClick={sendTest}
          disabled={testing || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(testTo.trim())}>
          {testing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}
          {t("admin.smtp.sendTestButton")}
        </Button>
      </div>
    </section>
  );
}
