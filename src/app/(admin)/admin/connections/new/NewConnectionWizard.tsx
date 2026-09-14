"use client";
/**
 * NewConnectionWizard — single-page form for /admin/connections/new.
 *
 * Sections, top to bottom:
 *   1. Kind picker — Postgres / Stripe / Salesforce-coming-soon
 *   2. Per-kind credentials
 *   3. Objects (postgres: dynamic list with PK / cursor config;
 *               stripe: checkbox grid of the 4 supported)
 *   4. Schedule (simple chooser + advanced cron toggle)
 *   5. Submit
 *
 * On success: redirect to /admin/connections/[id]/syncs.
 * On failure: inline error banner + the kind / credentials / objects
 * state stays so the user can fix and retry without re-typing.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/layout/PageHeader";
import {
  Database, CreditCard, Cloud, Plus, Trash2, Loader2, AlertTriangle, ArrowRight, Sparkles,
  Clock, MessageCircle,
} from "lucide-react";
import { cronMatches } from "@/lib/cron/cronMatches";
import { useT } from "@/lib/i18n/LocaleContext";

type Kind = "postgres" | "stripe" | "salesforce" | "line";
type CursorKind = "timestamp" | "xmin" | "id";
type PgObject = { name: string; schema: string; pkColumn: string; cursorColumn: string; cursorKind: CursorKind };
type StripeObject = "charges" | "customers" | "subscriptions" | "invoices";
type SfObject = "Opportunity" | "Account" | "Lead" | "User";

const SCHEDULE_OPTIONS = [
  { key: "every15m", cron: "*/15 * * * *" },
  { key: "everyHour", cron: "0 * * * *" },
  { key: "every6h", cron: "0 */6 * * *" },
  { key: "dailyAt6am", cron: "0 6 * * *" },
];

const STRIPE_OBJECTS: StripeObject[] = ["charges", "customers", "subscriptions", "invoices"];

const SF_OBJECTS: SfObject[] = ["Opportunity", "Account", "Lead", "User"];

export function NewConnectionWizard() {
  const router = useRouter();
  const { t } = useT();

  const scheduleOptions = useMemo(
    () => SCHEDULE_OPTIONS.map((o) => ({ ...o, label: t(`admin.newConnectionWizard.schedule.${o.key}`) })),
    [t]
  );

  // Section 1: kind
  const [kind, setKind] = useState<Kind | null>(null);

  // Section 2: per-kind credentials
  const [name, setName] = useState("");
  const [pgHost, setPgHost] = useState("");
  const [pgPort, setPgPort] = useState("5432");
  const [pgDb, setPgDb] = useState("");
  const [pgUser, setPgUser] = useState("");
  const [pgPassword, setPgPassword] = useState("");
  const [pgSchema, setPgSchema] = useState("public");
  const [pgSsl, setPgSsl] = useState(true);
  const [stripeKey, setStripeKey] = useState("");
  // Salesforce auth state — 5 fields, all required because we don't
  // run the OAuth dance from the wizard yet (the user obtains tokens
  // out-of-band via the Salesforce CLI; see docs/connectors/salesforce).
  const [sfInstanceUrl, setSfInstanceUrl] = useState("");
  const [sfClientId, setSfClientId] = useState("");
  const [sfClientSecret, setSfClientSecret] = useState("");
  const [sfAccessToken, setSfAccessToken] = useState("");
  const [sfRefreshToken, setSfRefreshToken] = useState("");
  // LINE — no objects/schedule: a single push-only message stream, not
  // multiple pollable source tables. See lib/sync/connectors/line.ts.
  const [lineAccessToken, setLineAccessToken] = useState("");
  const [lineSecret, setLineSecret] = useState("");

  // Section 3: objects
  const [pgObjects, setPgObjects] = useState<PgObject[]>([
    { name: "", schema: "public", pkColumn: "id", cursorColumn: "updated_at", cursorKind: "timestamp" },
  ]);
  const [stripeChosen, setStripeChosen] = useState<Set<StripeObject>>(new Set(STRIPE_OBJECTS));
  const [sfChosen, setSfChosen] = useState<Set<SfObject>>(new Set(SF_OBJECTS));

  // Section 4: schedule
  const [schedule, setSchedule] = useState(SCHEDULE_OPTIONS[1].cron);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [customCron, setCustomCron] = useState("");

  // Live preview of "next run" for the advanced cron input. We compute
  // client-side (cronMatches is pure JS) to validate the cron string +
  // give the user immediate feedback that their expression parses + the
  // schedule is actually firing when they expect. The tier clamp is
  // server-side — we don't preview it here because the user can't see
  // their own tier from this component cheaply, and the server side
  // is authoritative anyway.
  const cronPreview = useMemo<{ok: true; nextLabel: string} | {ok: false; error: string}>(() => {
    const expr = (advancedOpen ? customCron : schedule).trim();
    if (!expr) return { ok: false, error: "" };
    const parts = expr.split(/\s+/);
    if (parts.length !== 5) return { ok: false, error: t("admin.newConnectionWizard.cronErrorFields") };
    const now = new Date();
    // Brute-force search forward from now+1min. Same algorithm the
    // server uses (computeNextRunAt) so previews match server reality.
    const cursor = new Date(now.getTime() + 60_000);
    cursor.setSeconds(0, 0);
    for (let i = 0; i < 366 * 24 * 60; i++) {
      if (cronMatches(expr, cursor)) {
        return { ok: true, nextLabel: relativeFromNow(cursor.getTime() - now.getTime(), t) };
      }
      cursor.setMinutes(cursor.getMinutes() + 1);
    }
    return { ok: false, error: t("admin.newConnectionWizard.cronErrorNoFire") };
  }, [advancedOpen, customCron, schedule, t]);

  // Submit state
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!kind) { setError(t("admin.newConnectionWizard.errorPickKind")); return; }
    if (!name.trim()) { setError(t("admin.newConnectionWizard.errorName")); return; }

    const scheduleCron = advancedOpen && customCron.trim() ? customCron.trim() : schedule;

    let config: any;
    let objects: any[] | undefined;

    if (kind === "line") {
      if (!lineAccessToken.trim() || !lineSecret.trim()) {
        setError(t("admin.newConnectionWizard.errorLineRequired"));
        return;
      }
      config = { channelAccessToken: lineAccessToken.trim(), channelSecret: lineSecret.trim() };
      objects = undefined;
    } else if (kind === "postgres") {
      if (!pgHost || !pgDb || !pgUser || !pgPassword) {
        setError(t("admin.newConnectionWizard.errorPgRequired"));
        return;
      }
      const filtered = pgObjects.filter((o) => o.name.trim());
      if (filtered.length === 0) {
        setError(t("admin.newConnectionWizard.errorPgObjects"));
        return;
      }
      config = {
        host: pgHost.trim(),
        port: parseInt(pgPort, 10) || 5432,
        database: pgDb.trim(),
        user: pgUser.trim(),
        password: pgPassword,
        schema: pgSchema.trim() || "public",
        ssl: pgSsl,
      };
      objects = filtered.map((o) => ({
        name: o.name.trim(),
        schema: o.schema.trim() || pgSchema || "public",
        pkColumn: o.pkColumn.trim() || "id",
        cursorColumn: o.cursorColumn.trim() || "updated_at",
        cursorKind: o.cursorKind,
      }));
    } else if (kind === "stripe") {
      if (!stripeKey.trim()) {
        setError(t("admin.newConnectionWizard.errorStripeKey"));
        return;
      }
      if (stripeChosen.size === 0) {
        setError(t("admin.newConnectionWizard.errorStripeObjects"));
        return;
      }
      config = { apiKey: stripeKey.trim() };
      objects = [...stripeChosen].map((o) => ({
        name: o,
        pkColumn: "id",
        cursorColumn: "created",
        cursorKind: "id" as CursorKind,
      }));
    } else {
      // Salesforce.
      if (!sfInstanceUrl.trim() || !sfClientId.trim() || !sfClientSecret.trim() || !sfAccessToken.trim() || !sfRefreshToken.trim()) {
        setError(t("admin.newConnectionWizard.errorSfRequired"));
        return;
      }
      if (sfChosen.size === 0) {
        setError(t("admin.newConnectionWizard.errorSfObjects"));
        return;
      }
      config = {
        instanceUrl: sfInstanceUrl.trim().replace(/\/+$/, ""),
        clientId: sfClientId.trim(),
        clientSecret: sfClientSecret.trim(),
        accessToken: sfAccessToken.trim(),
        refreshToken: sfRefreshToken.trim(),
      };
      objects = [...sfChosen].map((o) => ({
        name: o,
        pkColumn: "Id",
        cursorColumn: "SystemModstamp",
        cursorKind: "timestamp" as CursorKind,
      }));
    }

    setBusy(true);
    try {
      const res = await fetch("/api/admin/connections", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(), kind, config, objects,
          scheduleCron: kind === "line" ? undefined : scheduleCron,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? `Server returned ${res.status}`);
      router.push(`/admin/connections/${json.connectionId}/syncs`);
    } catch (e: any) {
      setError(e?.message ?? t("admin.newConnectionWizard.errorCreateFailed"));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader className="mb-0" title={t("admin.newConnectionWizard.title")} description={t("admin.newConnectionWizard.subtitle")} />

      {/* Section 1 — kind */}
      <Section title={t("admin.newConnectionWizard.section1Title")}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <KindCard
            active={kind === "postgres"}
            onClick={() => setKind("postgres")}
            icon={Database}
            label={t("admin.newConnectionWizard.kind.postgres")}
            blurb={t("admin.newConnectionWizard.kind.postgres.blurb")}
          />
          <KindCard
            active={kind === "stripe"}
            onClick={() => setKind("stripe")}
            icon={CreditCard}
            label={t("admin.newConnectionWizard.kind.stripe")}
            blurb={t("admin.newConnectionWizard.kind.stripe.blurb")}
          />
          <KindCard
            active={kind === "salesforce"}
            onClick={() => setKind("salesforce")}
            icon={Cloud}
            label={t("admin.newConnectionWizard.kind.salesforce")}
            blurb={t("admin.newConnectionWizard.kind.salesforce.blurb")}
          />
          <KindCard
            active={kind === "line"}
            onClick={() => setKind("line")}
            icon={MessageCircle}
            label={t("admin.newConnectionWizard.kind.line")}
            blurb={t("admin.newConnectionWizard.kind.line.blurb")}
          />
        </div>
      </Section>

      {/* Section 2 — credentials */}
      {kind && (
        <Section title={t("admin.newConnectionWizard.section2Title")}>
          <div className="mb-3">
            <Field label={t("admin.newConnectionWizard.connectionName")} hint={t("admin.newConnectionWizard.connectionNameHint")}>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={kind === "postgres" ? t("admin.newConnectionWizard.connectionNamePlaceholder.postgres") : t("admin.newConnectionWizard.connectionNamePlaceholder.stripe")}
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </Field>
          </div>

          {kind === "postgres" && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label={t("admin.newConnectionWizard.host")}>
                <input value={pgHost} onChange={(e) => setPgHost(e.target.value)} placeholder="replica.example.com" className={inputCls} />
              </Field>
              <Field label={t("admin.newConnectionWizard.port")}>
                <input value={pgPort} onChange={(e) => setPgPort(e.target.value)} placeholder="5432" className={inputCls} />
              </Field>
              <Field label={t("admin.newConnectionWizard.database")}>
                <input value={pgDb} onChange={(e) => setPgDb(e.target.value)} placeholder="production" className={inputCls} />
              </Field>
              <Field label={t("admin.newConnectionWizard.schema")} hint={t("admin.newConnectionWizard.schemaHint")}>
                <input value={pgSchema} onChange={(e) => setPgSchema(e.target.value)} placeholder="public" className={inputCls} />
              </Field>
              <Field label={t("admin.newConnectionWizard.user")}>
                <input value={pgUser} onChange={(e) => setPgUser(e.target.value)} placeholder="curf_sync" className={inputCls} />
              </Field>
              <Field label={t("admin.newConnectionWizard.password")} hint={t("admin.newConnectionWizard.passwordHint")}>
                <input type="password" value={pgPassword} onChange={(e) => setPgPassword(e.target.value)} className={inputCls} />
              </Field>
              <Field label={t("admin.newConnectionWizard.ssl")}>
                <label className="inline-flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={pgSsl} onChange={(e) => setPgSsl(e.target.checked)} />
                  {t("admin.newConnectionWizard.sslRequire")}
                </label>
              </Field>
            </div>
          )}

          {kind === "stripe" && (
            <Field label={t("admin.newConnectionWizard.stripeApiKey")} hint={t("admin.newConnectionWizard.stripeApiKeyHint")}>
              <input
                type="password"
                value={stripeKey}
                onChange={(e) => setStripeKey(e.target.value)}
                placeholder="rk_test_..."
                className={inputCls}
              />
            </Field>
          )}

          {kind === "salesforce" && (
            <div className="space-y-3">
              <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
                <p>
                  {(() => {
                    const s = t("admin.newConnectionWizard.sfTokenModeBody");
                    const [pre, post] = s.split("{code}");
                    return (
                      <>
                        <span className="font-medium">{t("admin.newConnectionWizard.sfTokenModeLabel")}</span> {pre}
                        <code className="rounded bg-primary-soft px-1 py-0.5 font-mono">docs/connectors/salesforce</code>
                        {post}
                      </>
                    );
                  })()}
                </p>
              </div>
              <Field label={t("admin.newConnectionWizard.sfInstanceUrl")} hint={t("admin.newConnectionWizard.sfInstanceUrlHint")}>
                <input
                  type="text"
                  value={sfInstanceUrl}
                  onChange={(e) => setSfInstanceUrl(e.target.value)}
                  placeholder="https://yourorg.my.salesforce.com"
                  className={inputCls}
                />
              </Field>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Field label={t("admin.newConnectionWizard.sfClientId")}>
                  <input type="text" value={sfClientId} onChange={(e) => setSfClientId(e.target.value)} placeholder="3MVG9..." className={inputCls + " font-mono"} />
                </Field>
                <Field label={t("admin.newConnectionWizard.sfClientSecret")}>
                  <input type="password" value={sfClientSecret} onChange={(e) => setSfClientSecret(e.target.value)} className={inputCls} />
                </Field>
                <Field label={t("admin.newConnectionWizard.sfAccessToken")} hint={t("admin.newConnectionWizard.sfAccessTokenHint")}>
                  <input type="password" value={sfAccessToken} onChange={(e) => setSfAccessToken(e.target.value)} className={inputCls} />
                </Field>
                <Field label={t("admin.newConnectionWizard.sfRefreshToken")} hint={t("admin.newConnectionWizard.sfRefreshTokenHint")}>
                  <input type="password" value={sfRefreshToken} onChange={(e) => setSfRefreshToken(e.target.value)} className={inputCls} />
                </Field>
              </div>
            </div>
          )}

          {kind === "line" && (
            <div className="space-y-3">
              <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-[11px] text-success">
                {t("admin.newConnectionWizard.lineTokenModeBody")}
              </div>
              <Field label={t("admin.newConnectionWizard.lineChannelAccessToken")} hint={t("admin.newConnectionWizard.lineChannelAccessTokenHint")}>
                <input type="password" value={lineAccessToken} onChange={(e) => setLineAccessToken(e.target.value)} className={inputCls} />
              </Field>
              <Field label={t("admin.newConnectionWizard.lineChannelSecret")} hint={t("admin.newConnectionWizard.lineChannelSecretHint")}>
                <input type="password" value={lineSecret} onChange={(e) => setLineSecret(e.target.value)} className={inputCls} />
              </Field>
            </div>
          )}
        </Section>
      )}

      {/* Section 3 — objects */}
      {kind === "postgres" && (
        <Section title={t("admin.newConnectionWizard.section3Title")} hint={t("admin.newConnectionWizard.pgObjectsHint")}>
          <ul className="space-y-3">
            {pgObjects.map((o, i) => (
              <li key={i} className="rounded-md border border-border bg-muted/10 p-3">
                <div className="grid grid-cols-1 gap-2 md:grid-cols-5">
                  <Field label={t("admin.newConnectionWizard.table")} small>
                    <input value={o.name} onChange={(e) => updatePgObject(pgObjects, setPgObjects, i, { name: e.target.value })} placeholder="customers" className={inputCls} />
                  </Field>
                  <Field label={t("admin.newConnectionWizard.schema")} small>
                    <input value={o.schema} onChange={(e) => updatePgObject(pgObjects, setPgObjects, i, { schema: e.target.value })} placeholder="public" className={inputCls} />
                  </Field>
                  <Field label={t("admin.newConnectionWizard.pkColumn")} small>
                    <input value={o.pkColumn} onChange={(e) => updatePgObject(pgObjects, setPgObjects, i, { pkColumn: e.target.value })} placeholder="id" className={inputCls} />
                  </Field>
                  <Field label={t("admin.newConnectionWizard.cursorColumn")} small>
                    <input value={o.cursorColumn} onChange={(e) => updatePgObject(pgObjects, setPgObjects, i, { cursorColumn: e.target.value })} placeholder="updated_at" className={inputCls} />
                  </Field>
                  <Field label={t("admin.newConnectionWizard.cursorKind")} small>
                    <select
                      value={o.cursorKind}
                      onChange={(e) => updatePgObject(pgObjects, setPgObjects, i, { cursorKind: e.target.value as CursorKind })}
                      className={inputCls}
                    >
                      <option value="timestamp">timestamp</option>
                      <option value="xmin">xmin</option>
                      <option value="id">id</option>
                    </select>
                  </Field>
                </div>
                {pgObjects.length > 1 && (
                  <div className="mt-2 flex justify-end">
                    <button
                      type="button"
                      onClick={() => setPgObjects(pgObjects.filter((_, j) => j !== i))}
                      className="inline-flex h-7 items-center gap-1 rounded text-xs text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" />
                      {t("admin.newConnectionWizard.remove")}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setPgObjects([...pgObjects, { name: "", schema: pgSchema || "public", pkColumn: "id", cursorColumn: "updated_at", cursorKind: "timestamp" }])}
            className="mt-3 inline-flex h-8 items-center gap-1 rounded-md border border-dashed border-border bg-background px-3 text-xs font-medium text-muted-foreground hover:border-foreground/40 hover:text-foreground"
          >
            <Plus className="h-3 w-3" />
            {t("admin.newConnectionWizard.addAnotherTable")}
          </button>
        </Section>
      )}

      {kind === "stripe" && (
        <Section title={t("admin.newConnectionWizard.section3Title")} hint={t("admin.newConnectionWizard.stripeObjectsHint")}>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {STRIPE_OBJECTS.map((o) => (
              <label key={o} className={
                "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition " +
                (stripeChosen.has(o) ? "border-primary bg-primary/5" : "border-border bg-background hover:bg-accent/30")
              }>
                <input
                  type="checkbox"
                  checked={stripeChosen.has(o)}
                  onChange={(e) => {
                    const next = new Set(stripeChosen);
                    if (e.target.checked) next.add(o); else next.delete(o);
                    setStripeChosen(next);
                  }}
                />
                <span className="capitalize">{o}</span>
              </label>
            ))}
          </div>
        </Section>
      )}

      {kind === "salesforce" && (
        <Section title={t("admin.newConnectionWizard.section3Title")} hint={t("admin.newConnectionWizard.sfObjectsHint")}>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {SF_OBJECTS.map((o) => (
              <label key={o} className={
                "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition " +
                (sfChosen.has(o) ? "border-primary bg-primary/5" : "border-border bg-background hover:bg-accent/30")
              }>
                <input
                  type="checkbox"
                  checked={sfChosen.has(o)}
                  onChange={(e) => {
                    const next = new Set(sfChosen);
                    if (e.target.checked) next.add(o); else next.delete(o);
                    setSfChosen(next);
                  }}
                />
                <span>{o}</span>
              </label>
            ))}
          </div>
        </Section>
      )}

      {/* Section 4 — schedule (not applicable to LINE: push-only, nothing to poll) */}
      {kind && kind !== "line" && (
        <Section title={t("admin.newConnectionWizard.section4Title")} hint={t("admin.newConnectionWizard.section4Hint")}>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {scheduleOptions.map((s) => (
              <button
                key={s.cron}
                type="button"
                onClick={() => { setSchedule(s.cron); setAdvancedOpen(false); }}
                className={
                  "rounded-md border px-3 py-2 text-left text-sm transition " +
                  (!advancedOpen && schedule === s.cron
                    ? "border-primary bg-primary/5"
                    : "border-border bg-background hover:bg-accent/30")
                }
              >
                <div className="font-medium">{s.label}</div>
                <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{s.cron}</div>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="mt-3 text-xs text-muted-foreground hover:text-foreground"
          >
            {advancedOpen ? t("admin.newConnectionWizard.useSimpleChooser") : t("admin.newConnectionWizard.advancedCron")}
          </button>
          {advancedOpen && (
            <div className="mt-3">
              <Field label={t("admin.newConnectionWizard.customCron")} hint={t("admin.newConnectionWizard.customCronHint")}>
                <input value={customCron} onChange={(e) => setCustomCron(e.target.value)} placeholder="0 */4 * * 1-5" className={inputCls + " font-mono"} />
              </Field>
            </div>
          )}
          {/* Live next-run preview. Renders only when there's something
              to validate against — empty input shows nothing rather than
              "parse error" before the user has typed. */}
          {(advancedOpen ? customCron.trim() : schedule).length > 0 && (
            <div className="mt-3 flex items-start gap-2 text-[11px]">
              <Clock className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
              {cronPreview.ok ? (
                <span className="text-muted-foreground" suppressHydrationWarning>
                  {t("admin.newConnectionWizard.nextRun")} <span className="font-medium text-foreground">{cronPreview.nextLabel}</span>
                  {!advancedOpen && (
                    <span className="ml-2 opacity-60">{t("admin.newConnectionWizard.tierLimitsApply")}</span>
                  )}
                </span>
              ) : cronPreview.error ? (
                <span className="text-destructive">{cronPreview.error}</span>
              ) : null}
            </div>
          )}
        </Section>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Submit */}
      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={() => router.push("/admin/connections")}
          className="inline-flex h-9 items-center rounded-md border border-border bg-background px-4 text-sm font-medium hover:bg-accent/30"
        >
          {t("action.cancel")}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy || !kind}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {t("admin.newConnectionWizard.submitCreate")}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function updatePgObject(
  list: PgObject[],
  set: (next: PgObject[]) => void,
  index: number,
  patch: Partial<PgObject>,
) {
  set(list.map((o, i) => (i === index ? { ...o, ...patch } : o)));
}

/** Format an ms delta as a "in 4h 12m" / "in 28 days" string for the
 *  cron-preview row in the wizard. Mirrors the unit cascade used on
 *  the syncs page but always carries the "in " prefix. */
function relativeFromNow(ms: number, t: (key: string) => string): string {
  if (ms <= 0) return t("admin.newConnectionWizard.relNow");
  const min = Math.floor(ms / 60_000);
  if (min < 1) return t("admin.newConnectionWizard.relLessThanMin");
  if (min < 60) return t("admin.newConnectionWizard.relMin").replace("{min}", String(min));
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) return remMin
    ? t("admin.newConnectionWizard.relHourMin").replace("{hr}", String(hr)).replace("{min}", String(remMin))
    : t("admin.newConnectionWizard.relHour").replace("{hr}", String(hr));
  const day = Math.floor(hr / 24);
  const remHr = hr % 24;
  if (day < 7) return remHr
    ? t("admin.newConnectionWizard.relDayHour").replace("{day}", String(day)).replace("{hr}", String(remHr))
    : t("admin.newConnectionWizard.relDay").replace("{day}", String(day));
  return t("admin.newConnectionWizard.relDay").replace("{day}", String(day));
}

const inputCls =
  "h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Field({ label, hint, small, children }: { label: string; hint?: string; small?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={"block " + (small ? "text-[10px] font-medium uppercase tracking-wider text-muted-foreground" : "text-xs font-medium text-foreground/80")}>
        {label}
      </span>
      <div className={small ? "mt-1" : "mt-1.5"}>{children}</div>
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </label>
  );
}

function KindCard({
  active, disabled, onClick, icon: Icon, label, blurb,
}: {
  active: boolean;
  disabled?: boolean;
  onClick?: () => void;
  icon: typeof Database;
  label: string;
  blurb: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        "rounded-lg border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
        (active ? "border-primary bg-primary/5 ring-2 ring-primary/40" : "border-border bg-card hover:border-primary/40 hover:bg-accent/30")
      }
    >
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold text-foreground">{label}</span>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">{blurb}</p>
    </button>
  );
}
