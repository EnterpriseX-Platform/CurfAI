"use client";
/**
 * BackupDestinationsPanel — admin UI for off-site backup destinations.
 *
 * Sits next to BackupsPanel under /tables. Lists existing destinations,
 * shows the most recent shipments per destination, and lets the admin:
 *   - Add a new destination (driver picker + form generated from
 *     driver.fields)
 *   - Test the connection (ships a tiny synthetic payload)
 *   - Pause / resume
 *   - Delete (does NOT touch remote files — just stops shipping)
 *
 * Uploads happen automatically: every time snapshotTenant() succeeds we
 * fan out to every enabled destination. The "Re-ship" buttons in the
 * Backups panel can target a specific destination via /[id]?action=ship.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "@/lib/i18n/LocaleContext";
import {
  CloudUpload, Plus, Loader2, Check, X, AlertTriangle, Trash2, Pause, Play,
  Activity, ZapOff, Clock,
} from "lucide-react";

type Field = {
  name: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  required?: boolean;
  type?: "text" | "url" | "json";
};

type DriverDef = {
  key: string;
  label: string;
  hint: string;
  fields: Field[];
};

type Destination = {
  id: string;
  name: string;
  driver: string;
  config: any;
  shipKinds: string;
  enabled: boolean;
  lastShipAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  createdAt: string;
};

type Shipment = {
  id: string;
  destinationId: string;
  destinationName: string;
  driver: string;
  status: "ok" | "failed";
  bytesSent: number;
  durationMs: number;
  responseCode: number | null;
  error: string | null;
  createdAt: string;
};

export function BackupDestinationsPanel({ canAdmin }: { canAdmin: boolean }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Destination[] | null>(null);
  const [drivers, setDrivers] = useState<DriverDef[]>([]);
  const [shipments, setShipments] = useState<Shipment[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Create-form state — driver-keyed so we don't lose user input on
  // accidental driver-switch.
  const [name, setName] = useState("");
  const [driverKey, setDriverKey] = useState("https-put");
  const [shipKinds, setShipKinds] = useState("auto,manual");
  const [config, setConfig] = useState<Record<string, any>>({});

  const driver = useMemo(
    () => drivers.find((d) => d.key === driverKey) ?? drivers[0],
    [drivers, driverKey],
  );

  const load = useCallback(async () => {
    try {
      const [destR, shipR] = await Promise.all([
        fetch("/api/lake/backup-destinations", { cache: "no-store", credentials: "include" }),
        fetch("/api/lake/backup-shipments?take=20", { cache: "no-store", credentials: "include" }),
      ]);
      if (destR.ok) {
        const j = await destR.json();
        setItems(j.items ?? []);
        setDrivers(j.drivers ?? []);
        // Functional update so we don't need `driver` in the callback deps.
        // Falls back to the first server-known driver when the current key
        // isn't in the returned list.
        const known: DriverDef[] = j.drivers ?? [];
        setDriverKey((prev) => known.some((d) => d.key === prev) ? prev : (known[0]?.key ?? prev));
      }
      if (shipR.ok) {
        const j = await shipR.json();
        setShipments(j.items ?? []);
      }
    } catch { /* silent */ }
  }, []);

  useEffect(() => { if (open && items === null) void load(); }, [open, items, load]);

  function setField(name: string, value: any) {
    setConfig((c) => ({ ...c, [name]: value }));
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!driver) return;
    setBusy("create"); setError(null); setSuccess(null);
    try {
      // For JSON-typed fields, attempt to parse before sending
      const parsedConfig: any = {};
      for (const f of driver.fields) {
        const raw = config[f.name];
        if (f.type === "json" && typeof raw === "string" && raw.trim()) {
          try { parsedConfig[f.name] = JSON.parse(raw); }
          catch { throw new Error(`${f.label} must be valid JSON`); }
        } else if (raw !== undefined && raw !== "") {
          parsedConfig[f.name] = raw;
        }
      }
      const r = await fetch("/api/lake/backup-destinations", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          driver: driverKey,
          config: parsedConfig,
          shipKinds,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? `Server returned ${r.status}`);
      setSuccess(t("backupDest.createdMsg").replace("{name}", name));
      setName(""); setConfig({}); setShipKinds("auto,manual"); setCreating(false);
      setItems(null); void load();
    } catch (e: any) {
      setError(e?.message ?? t("backupDest.createFailedFallback"));
    } finally { setBusy(null); }
  }

  async function toggle(id: string) {
    setBusy(`toggle-${id}`);
    try {
      const r = await fetch(`/api/lake/backup-destinations/${id}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "toggle" }),
      });
      if (r.ok) { setItems(null); void load(); }
    } finally { setBusy(null); }
  }

  async function test(id: string) {
    setBusy(`test-${id}`); setError(null); setSuccess(null);
    try {
      const r = await fetch(`/api/lake/backup-destinations/${id}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "test" }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? `Server returned ${r.status}`);
      if (j.result.status === "ok") {
        setSuccess(t("backupDest.testOkMsg").replace("{bytes}", String(j.result.bytesSent)).replace("{ms}", String(j.result.durationMs)).replace("{code}", String(j.result.responseCode)));
      } else {
        setError(t("backupDest.testFailedMsg").replace("{error}", j.result.error ?? `HTTP ${j.result.responseCode}`));
      }
      setItems(null); void load();
    } catch (e: any) {
      setError(e?.message ?? t("backupDest.testFailedFallback"));
    } finally { setBusy(null); }
  }

  async function remove(id: string) {
    if (!confirm(t("backupDest.removeConfirm"))) return;
    setBusy(`del-${id}`);
    try {
      const r = await fetch(`/api/lake/backup-destinations/${id}`, { method: "DELETE", credentials: "include" });
      if (r.ok) { setItems((xs) => (xs ?? []).filter((d) => d.id !== id)); }
    } finally { setBusy(null); }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-5 shadow-xs">
      <header className="flex items-center justify-between">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-2 text-left">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <CloudUpload className="h-3.5 w-3.5" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">{t("backupDest.heading")}</h2>
            <p className="text-[11px] text-muted-foreground">
              {t("backupDest.subtitle")}
            </p>
          </div>
        </button>
        <span className="text-muted-foreground">{open ? "▲" : "▼"}</span>
      </header>

      {open && (
        <div className="mt-4 space-y-3">
          {canAdmin && !creating && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
            >
              <Plus className="h-3 w-3" /> {t("backupDest.addButton")}
            </button>
          )}

          {creating && driver && (
            <form onSubmit={create} className="grid gap-2 rounded-md border border-dashed border-border bg-muted/20 p-3">
              <div className="grid gap-2 md:grid-cols-2">
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("common.name")}</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t("backupDest.namePlaceholder")}
                    required maxLength={80}
                    className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-xs"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("backupDest.driverLabel")}</span>
                  <select
                    value={driverKey}
                    onChange={(e) => setDriverKey(e.target.value)}
                    className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-xs"
                  >
                    {drivers.map((d) => (
                      <option key={d.key} value={d.key}>{d.label}</option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="text-[10px] text-muted-foreground">{driver.hint}</p>

              {driver.fields.map((f) => (
                <label key={f.name} className="block">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {f.label} {f.required && <span className="text-destructive">*</span>}
                  </span>
                  {f.type === "json" ? (
                    <textarea
                      value={config[f.name] ?? ""}
                      onChange={(e) => setField(f.name, e.target.value)}
                      placeholder={f.placeholder}
                      rows={2}
                      className="mt-1 w-full rounded border border-border bg-background p-2 font-mono text-[11px]"
                    />
                  ) : (
                    <input
                      type={f.secret ? "password" : (f.type === "url" ? "url" : "text")}
                      value={config[f.name] ?? ""}
                      onChange={(e) => setField(f.name, e.target.value)}
                      placeholder={f.placeholder}
                      required={f.required}
                      className="mt-1 h-8 w-full rounded border border-border bg-background px-2 font-mono text-[11px]"
                    />
                  )}
                </label>
              ))}

              <div className="grid gap-2 md:grid-cols-2">
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("backupDest.shipWhichLabel")}</span>
                  <select
                    value={shipKinds}
                    onChange={(e) => setShipKinds(e.target.value)}
                    className="mt-1 h-8 w-full rounded border border-border bg-background px-2 text-xs"
                  >
                    <option value="auto,manual">{t("backupDest.shipAll")}</option>
                    <option value="auto">{t("backupDest.shipNightly")}</option>
                    <option value="manual">{t("backupDest.shipManual")}</option>
                  </select>
                </label>
                <div className="mt-5 flex items-center gap-1">
                  <button
                    type="submit"
                    disabled={busy === "create" || !name.trim()}
                    className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-2.5 text-[11px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {busy === "create" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                    {t("action.create")}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setCreating(false); setName(""); setConfig({}); }}
                    className="h-8 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-muted"
                  >
                    {t("action.cancel")}
                  </button>
                </div>
              </div>
            </form>
          )}

          {success && (
            <div className="flex items-start gap-1.5 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-xs text-success ">
              <Check className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{success}</span>
              <button type="button" onClick={() => setSuccess(null)} className="ml-auto rounded p-0.5 hover:bg-success/20"><X className="h-3 w-3" /></button>
            </div>
          )}
          {error && (
            <div className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{error}</span>
              <button type="button" onClick={() => setError(null)} className="ml-auto rounded p-0.5 hover:bg-destructive/20"><X className="h-3 w-3" /></button>
            </div>
          )}

          {items === null && <p className="text-xs text-muted-foreground">{t("backupDest.loading")}</p>}
          {items !== null && items.length === 0 && !creating && (
            <p className="rounded-md border border-dashed border-border bg-muted/10 px-3 py-3 text-center text-[11px] text-muted-foreground">
              {t("backupDest.emptyState")}
            </p>
          )}

          {items !== null && items.length > 0 && (
            <ul className="divide-y divide-border rounded-md border border-border bg-background">
              {items.map((d) => (
                <li key={d.id} className="px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-semibold">{d.name}</span>
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">{d.driver}</span>
                        {!d.enabled && <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">{t("backupDest.pausedBadge")}</span>}
                        <span className={
                          "rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider " +
                          (d.lastStatus === "ok" ? "bg-success/10 text-success" :
                           d.lastStatus === "failed" ? "bg-destructive/10 text-destructive" :
                           "bg-muted text-muted-foreground")
                        }>
                          {d.lastStatus ?? t("backupDest.neverShipped")}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {d.lastShipAt ? new Date(d.lastShipAt).toLocaleString() : t("backupDest.awaitingFirstSnapshot")}
                        <span>· {t("backupDest.shipsSuffix").replace("{kinds}", d.shipKinds.replace(",", " + "))}</span>
                      </div>
                      {d.lastError && (
                        <p className="mt-1 truncate font-mono text-[10px] text-destructive" title={d.lastError}>
                          {d.lastError.slice(0, 120)}
                        </p>
                      )}
                    </div>
                    {canAdmin && (
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => test(d.id)}
                          disabled={!!busy}
                          className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] hover:bg-muted disabled:opacity-50"
                          title={t("backupDest.testTitle")}
                        >
                          {busy === `test-${d.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Activity className="h-3 w-3" />}
                          {t("action.test")}
                        </button>
                        <button
                          type="button"
                          onClick={() => toggle(d.id)}
                          disabled={!!busy}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                          title={d.enabled ? t("backupDest.pauseTitle") : t("backupDest.resumeTitle")}
                        >
                          {d.enabled ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(d.id)}
                          disabled={!!busy}
                          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                          title={t("backupDest.removeTitle")}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* Recent shipments — audit trail */}
          {shipments && shipments.length > 0 && (
            <details className="rounded-md border border-border bg-background px-3 py-2">
              <summary className="cursor-pointer text-[11px] font-semibold text-muted-foreground hover:text-foreground">
                {t("backupDest.recentShipments").replace("{n}", String(shipments.length))}
              </summary>
              <ul className="mt-2 max-h-56 divide-y divide-border overflow-y-auto text-[11px]">
                {shipments.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2 py-1.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        {s.status === "ok" ? (
                          <Check className="h-3 w-3 text-success" />
                        ) : (
                          <ZapOff className="h-3 w-3 text-destructive" />
                        )}
                        <span className="truncate font-medium">{s.destinationName}</span>
                        {s.responseCode != null && (
                          <span className="rounded bg-muted px-1 py-0.5 text-[9px] font-mono text-muted-foreground">{s.responseCode}</span>
                        )}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {(s.bytesSent / 1024).toFixed(1)} KB · {s.durationMs}ms · {new Date(s.createdAt).toLocaleString()}
                      </div>
                      {s.error && (
                        <p className="mt-0.5 truncate font-mono text-[10px] text-destructive" title={s.error}>{s.error.slice(0, 100)}</p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
