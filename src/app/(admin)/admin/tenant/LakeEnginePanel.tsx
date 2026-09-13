"use client";
/**
 * LakeEnginePanel — pick SQLite or DuckDB for this tenant's lake.
 *
 * Two cards. SQLite is free + recommended for under-1M-row tables;
 * DuckDB is Team+ and recommended for analytical scans on larger
 * tables. The non-active card has a "Migrate to <engine>" CTA.
 *
 * Click → preflight runs first (SQL static-analysis across reports +
 * MVs + pipelines). Findings render with severity. If 0 errors, the
 * admin can confirm and the migration runs inline. If errors exist,
 * the migrate button is disabled until the admin fixes their queries
 * and re-runs preflight.
 */
import { useEffect, useState } from "react";
import { Loader2, Database, AlertTriangle, Check, ArrowRight, Cpu } from "lucide-react";
import { useT } from "@/lib/i18n/LocaleContext";

type Status = {
  engine: "sqlite" | "duckdb";
  sizeBytes: number;
  migratedAt: string | null;
  /** True when @duckdb/node-api is installed in this deployment. When
   *  false the DuckDB EngineCard is shown but disabled with an
   *  "install to unlock" hint — DuckDB is an optional dep. */
  duckDbAvailable?: boolean;
};

type Finding = { severity: "error" | "warning"; message: string; snippet: string };
type SourceResult = { origin: string; findings: Finding[] };
type Preflight = {
  preflight: { sources: SourceResult[]; totalChecked: number; errorCount: number; warningCount: number };
  fromEngine: "sqlite" | "duckdb";
  toEngine: "sqlite" | "duckdb";
};

function formatBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

export function LakeEnginePanel() {
  const { t } = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<"sqlite" | "duckdb" | null>(null);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [busy, setBusy] = useState<"preflight" | "migrate" | null>(null);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/tenant/lake-engine");
      if (r.ok) setStatus(await r.json());
    } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function runPreflight(to: "sqlite" | "duckdb") {
    setTarget(to); setPreflight(null); setError(null); setResult(null);
    setBusy("preflight");
    try {
      const r = await fetch("/api/admin/tenant/lake-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toEngine: to, preflight: true }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? t("admin.lakeEngine.serverReturnedError").replace("{status}", String(r.status)));
      setPreflight(j);
    } catch (e: any) {
      setError(e?.message ?? t("admin.lakeEngine.preflightFailedFallback"));
    } finally { setBusy(null); }
  }

  async function runMigration() {
    if (!target) return;
    setBusy("migrate"); setError(null); setResult(null);
    try {
      const r = await fetch("/api/admin/tenant/lake-engine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toEngine: target }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? t("admin.lakeEngine.serverReturnedError").replace("{status}", String(r.status)));
      setResult(j.result);
      setPreflight(null);
      void load();
    } catch (e: any) {
      setError(e?.message ?? t("admin.lakeEngine.migrationFailedFallback"));
    } finally { setBusy(null); }
  }

  if (loading || !status) {
    return (
      <div className="mb-8 flex items-center gap-2 rounded-lg border bg-card p-5 text-sm text-muted-foreground shadow-xs">
        <Loader2 className="h-4 w-4 animate-spin" /> {t("admin.lakeEngine.loading")}
      </div>
    );
  }

  const errorCount = preflight?.preflight.errorCount ?? 0;
  const warningCount = preflight?.preflight.warningCount ?? 0;
  const canMigrate = preflight && errorCount === 0;

  return (
    <section className="mb-8 rounded-lg border bg-card p-5 shadow-xs">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Database className="mr-1 inline h-3 w-3 -translate-y-px" />
            {t("admin.lakeEngine.title")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("admin.lakeEngine.description")}
          </p>
        </div>
        <span className="rounded-full bg-success/10 px-2.5 py-1 text-xs font-medium text-success">
          {formatBytes(status.sizeBytes)}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <EngineCard
          id="sqlite"
          active={status.engine === "sqlite"}
          title="SQLite"
          subtitle={t("admin.lakeEngine.sqliteSubtitle")}
          bullets={[
            t("admin.lakeEngine.sqliteBullet1"),
            t("admin.lakeEngine.sqliteBullet2"),
            t("admin.lakeEngine.sqliteBullet3"),
          ]}
          onMigrate={() => runPreflight("sqlite")}
        />
        <EngineCard
          id="duckdb"
          active={status.engine === "duckdb"}
          title="DuckDB"
          subtitle={status.duckDbAvailable === false
            ? <>{t("admin.lakeEngine.duckdbSubtitleUnavailablePre")} <code>npm install @duckdb/node-api</code> {t("admin.lakeEngine.duckdbSubtitleUnavailablePost")}</>
            : t("admin.lakeEngine.duckdbSubtitleAvailable")}
          tier="Growth+"
          disabled={status.duckDbAvailable === false}
          bullets={[
            t("admin.lakeEngine.duckdbBullet1"),
            t("admin.lakeEngine.duckdbBullet2"),
            t("admin.lakeEngine.duckdbBullet3"),
          ]}
          onMigrate={() => runPreflight("duckdb")}
        />
      </div>

      {status.migratedAt && (
        <p className="mt-3 text-[11px] text-muted-foreground">
          {t("admin.lakeEngine.lastMigrated").replace("{date}", new Date(status.migratedAt).toLocaleString())}
        </p>
      )}

      {/* Preflight findings */}
      {busy === "preflight" && (
        <div className="mt-4 flex items-center gap-2 rounded-md border border-border bg-muted/20 p-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t("admin.lakeEngine.runningPreflight")}
        </div>
      )}

      {preflight && (
        <div className="mt-4 rounded-md border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between gap-2 text-xs">
            <p className="font-semibold">
              {t("admin.lakeEngine.preflightLabel")} {preflight.fromEngine}
              <ArrowRight className="mx-2 inline h-3 w-3 -translate-y-px" />
              {preflight.toEngine}
            </p>
            <span className="text-muted-foreground">
              {preflight.preflight.totalChecked} {preflight.preflight.totalChecked === 1 ? t("admin.lakeEngine.queryCheckedSingular") : t("admin.lakeEngine.queryCheckedPlural")} ·{" "}
              {errorCount > 0 && <span className="font-semibold text-destructive">{errorCount} {errorCount === 1 ? t("admin.lakeEngine.errorSingular") : t("admin.lakeEngine.errorPlural")}</span>}
              {errorCount > 0 && warningCount > 0 && " · "}
              {warningCount > 0 && <span className="font-semibold text-warning">{warningCount} {warningCount === 1 ? t("admin.lakeEngine.warningSingular") : t("admin.lakeEngine.warningPlural")}</span>}
              {errorCount === 0 && warningCount === 0 && <span className="font-semibold text-success">{t("admin.lakeEngine.allClear")}</span>}
            </span>
          </div>

          {preflight.preflight.sources.length > 0 ? (
            <ul className="space-y-2 max-h-60 overflow-y-auto">
              {preflight.preflight.sources.map((s, i) => (
                <li key={i} className="rounded border border-border bg-muted/30 p-2 text-xs">
                  <p className="font-semibold">{s.origin}</p>
                  <ul className="mt-1 space-y-1">
                    {s.findings.map((f, j) => (
                      <li key={j} className="flex items-start gap-1.5">
                        {f.severity === "error"
                          ? <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
                          : <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" />}
                        <div className="min-w-0 flex-1">
                          <p>{f.message}</p>
                          <code className="mt-0.5 block break-all rounded bg-background p-1 font-mono text-[10px] text-muted-foreground">{f.snippet}</code>
                        </div>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">{t("admin.lakeEngine.allCompatible")}</p>
          )}

          <div className="mt-4 flex items-center justify-end gap-2 border-t border-border pt-3">
            <button
              type="button"
              onClick={() => { setPreflight(null); setTarget(null); }}
              className="rounded-md px-3 py-1.5 text-xs hover:bg-muted"
            >
              {t("action.cancel")}
            </button>
            <button
              type="button"
              onClick={runMigration}
              disabled={!canMigrate || busy === "migrate"}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {busy === "migrate" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Database className="h-3 w-3" />}
              {busy === "migrate" ? t("admin.lakeEngine.migrating") : t("admin.lakeEngine.migrateTo").replace("{target}", String(target))}
            </button>
          </div>

          {!canMigrate && errorCount > 0 && (
            <p className="mt-2 text-[11px] text-destructive">
              {(errorCount === 1 ? t("admin.lakeEngine.fixErrorsSingular") : t("admin.lakeEngine.fixErrorsPlural")).replace("{n}", String(errorCount))}
            </p>
          )}
        </div>
      )}

      {result && (
        <div className="mt-4 rounded-md border border-success/40 bg-success/10 p-3 text-xs text-success  ">
          <Check className="mr-1 inline h-3 w-3" />
          {t("admin.lakeEngine.migratedPrefix")} <code className="font-mono">{result.fromEngine}</code> → <code className="font-mono">{result.toEngine}</code>:
          {" "}{t("admin.lakeEngine.migratedSummary")
            .replace("{tables}", String(result.tableCount))
            .replace("{rows}", result.rowCount.toLocaleString())
            .replace("{duration}", (result.durationMs / 1000).toFixed(1))}
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          <AlertTriangle className="mr-1 inline h-3 w-3" /> {error}
        </div>
      )}
    </section>
  );
}

function EngineCard({ id, active, title, subtitle, bullets, tier, onMigrate, disabled }: {
  id: string;
  active: boolean;
  title: string;
  subtitle: React.ReactNode;
  bullets: string[];
  tier?: string;
  onMigrate: () => void;
  /** When true, the migrate button is disabled and the card is dimmed.
   *  Used for DuckDB when @duckdb/node-api isn't installed in this
   *  deployment — surfaces an "install to unlock" hint instead of a 500. */
  disabled?: boolean;
}) {
  const { t } = useT();
  return (
    <div className={
      "rounded-md border p-3 transition " +
      (active ? "border-primary/40 bg-primary/5" :
       disabled ? "border-border bg-muted/30 opacity-75" :
       "border-border bg-background")
    }>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-muted-foreground" />
          <p className="text-sm font-semibold">{title}</p>
          {active && <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-primary">{t("admin.lakeEngine.activeBadge")}</span>}
          {disabled && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{t("admin.lakeEngine.notInstalledBadge")}</span>
          )}
        </div>
        {tier && !active && <span className="rounded-full bg-warning/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-warning">{tier}</span>}
      </div>
      <p className="mb-2 text-[11px] text-muted-foreground">{subtitle}</p>
      <ul className="mb-3 space-y-0.5 text-[11px] text-muted-foreground">
        {bullets.map((bullet, i) => (
          <li key={i} className="flex items-start gap-1">
            <Check className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/60" />
            <span>{bullet}</span>
          </li>
        ))}
      </ul>
      {!active && (
        <button
          type="button"
          onClick={onMigrate}
          disabled={disabled}
          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-semibold hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-background"
        >
          {disabled ? t("admin.lakeEngine.installRequired") : t("admin.lakeEngine.migrateTo").replace("{target}", title)}
        </button>
      )}
    </div>
  );
}
