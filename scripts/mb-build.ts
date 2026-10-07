/**
 * Master Builder, driven unattended: start a build step from a brief, wait
 * for it with a heartbeat, resume what failed, and finish with one
 * machine-readable summary and an exit code. Local development only — it
 * signs in as the seeded dev admin and refuses a non-local server.
 *
 *   npx tsx scripts/mb-build.ts <workspaceSlug> <briefFile> [options]
 *
 * What it does (default "chat step": add to the workspace's newest build):
 *   1. iterate   the brief becomes a change plan (retried on a model failure)
 *   2. apply     the plan is applied in the BACKGROUND, strict: a report the
 *                model cannot design FAILS instead of being saved as a
 *                "Simplified" overview; polled with a heartbeat
 *   3. resume    only the reports that did not land are applied again
 *                (--retries times, with backoff); finished work is not redone
 *   3b. verify   (--verify) the built app is opened in a browser and measured (scripts/mb-verify.ts): clipped
 *                text, tables running off their card, raw money, wrong-language words, blank charts, dead
 *                drill-downs. What code can fix is fixed through the report gate (titles cut to fit, columns
 *                dropped to the ones that fit, compact money, table heights, missing translations); what
 *                needs judgement goes to Master Builder as a concrete repair brief (iterate -> strict apply);
 *                then the app is verified again - until nothing at warn or above is left, a round changes
 *                nothing, or --verify-rounds is spent
 *   4. summary   per-stage timings, LLM calls (latency, tokens, retries,
 *                errors), fallbacks, report ids -> stdout as `MB_SUMMARY {json}`
 *
 * Brief delivery: the brief is read for what it asks (tabs, chart kinds, a What-if, the fiscal year, the KPIs it names with their targets;
 * src/lib/master-builder/briefConstraints.ts), the built app is walked for what it holds, and
 * MB_SUMMARY.briefDelivery = { asked, built, missing[] } says what did not land. Every timing carries tokensIn /
 * tokensOut (the credit the step spent) and changedNothing when it spent some and changed nothing.
 *
 * Final state, also the exit code:
 *   built                          0   everything asked for landed, no fallback
 *   built with missing asks: ...   2   (a chart kind or a KPI the brief named is not in the built app)
 *   verify removed delivered content: ...   1   (--verify) an ask delivered before the repair loop is gone after it
 *                                      (MB_SUMMARY.briefDeliveryAfterVerify.regressions)
 *   failed: what-if requested, none built   1   the brief asked for a What-if and the app has none
 *   failed: tabs short: asked N, built M    1   fewer report tabs than the brief asked for
 *   built with fallback on <name>  2   (only with --allow-fallback) a Simplified report landed;
 *                                      with --verify: also warnings the repair loop could not clear
 *   built, verify left N error(s)  1   (--verify) the app still has errors (failed query, blank chart...)
 *   failed at <stage>: <reason>    1   gave up; what finished is kept
 *
 * Options:
 *   --build <id>          iterate this build (default: the workspace's newest ready build)
 *   --new-build           plan + build a brand-new build from the brief instead (plan job, resumed
 *                         from its last good stage on failure; then a background first-build apply)
 *   --app-slug <slug>     the slug the built app gets. A new build's app is found by the id the build produced (never by
 *                         slug: an older app may hold it), renamed to the slug right after the build (before --verify
 *                         opens it) when the slug is free; when another app holds it the produced app keeps its own
 *                         slug and MB_SUMMARY.app reports requestedSlug / actualSlug / slugCollision. A chat step
 *                         looks the app up by the slug. --verify opens the app by its real slug.
 *   --allow-missing       a brief ask that was not delivered (chart kind, tabs, What-if) is listed in
 *                         MB_SUMMARY.briefDelivery.missing but does not change the exit code
 *   --step-tokens <n>     token (in + out) budget of one iterate step (default 150000; the server caps it too)
 *   --verify              after the apply, verify the app in a browser and repair it (needs --app-slug)
 *   --verify-rounds <n>   repair rounds at most (default 3)
 *   --verify-locales a,b  languages to open (default en,th,zh)
 *   --verify-only         no brief: verify and repair an app already built (--app-slug; --build for the follow-up step)
 *   --verify-regen <n>    times Master Builder may regenerate the same report to clear what code cannot (default 1:
 *                         a regeneration the model did not get right is not asked for again)
 *   --verify-no-iterate   repair only what code can (no Master Builder follow-up for the rest)
 *   --retries <n>         resume attempts per step (default 3)
 *   --budget-min <m>      overall wall-clock budget (default 30)
 *   --allow-fallback      accept a "Simplified" report instead of failing and retrying it
 *   --cleanup             afterwards delete what this run created and restore the build row
 *                         (only for an additive brief: refuses a plan that removes/modifies anything)
 *   --dry-run             plan only (iterate / plan job), apply nothing; reports the plan
 *   --bench <n>           dry-run n times and report latency percentiles + success rate
 *   --concurrency <c>     with --bench: run c at once (default 1)
 *   --base <url>          server (default http://localhost:3100)
 *   --out <file>          also write the summary JSON there
 *
 * Server-side knobs (env of the dev server): CURF_LLM_CONCURRENCY, CURF_LLM_RETRIES,
 * CURF_LLM_STREAM=off, CURF_LLM_IDLE_MS, CURF_MB_STAGE_TIMEOUT_MS, CURF_MB_STAGE_ATTEMPTS,
 * CURF_MB_REPORT_ATTEMPTS, CURF_MB_PLAN_BUDGET_MS, CURF_MB_ITERATE_BUDGET_MS (wall-clock of one iterate step, default
 * 8 min), CURF_MB_ITERATE_TOKEN_BUDGET (tokens of one iterate step, default 150k), CURF_MB_WHATIF_MODEL=off (skip the
 * model's What-if design: the code fallback builds the tab, labelled auto-generated - how that path is tested on purpose).
 */
import fs from "node:fs";
import { prisma } from "../src/lib/db";
import {
  extractBriefConstraints, builtAppFacts, evaluateBriefDelivery, validatePlanAgainstBriefSplit, expectedReportCount, deliveryRegressions, type BriefConstraints,
} from "../src/lib/master-builder/briefConstraints";
import { locateBuiltApp, type BuiltAppDb, type BuiltAppRow } from "../src/lib/master-builder/builtApp";
import { isAppSlugTaken } from "../src/lib/apps/slug";
import { applyDidNoWork, applyCauseFromMessage, stepChangedNothing, summariseGuard } from "../src/lib/master-builder/driverChecks";

// ── args ─────────────────────────────────────────────────────────────

type Opts = {
  slug: string; briefFile: string; build?: string; newBuild: boolean; appSlug?: string;
  retries: number; budgetMs: number; allowFallback: boolean; cleanup: boolean; dryRun: boolean;
  bench: number; concurrency: number; base: string; out?: string;
  verify: boolean; verifyOnly: boolean; verifyRounds: number; verifyLocales: string[]; verifyIterate: boolean; verifyRegen: number;
  allowMissing: boolean; stepTokens: number;
};

function parseArgs(argv: string[]): Opts {
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--") && !["new-build", "allow-fallback", "cleanup", "dry-run", "verify", "verify-only", "verify-no-iterate", "allow-missing"].includes(key)) { flags.set(key, next); i++; }
    else flags.set(key, true);
  }
  if (pos.length < (flags.has("verify-only") ? 1 : 2)) {
    console.error("usage: npx tsx scripts/mb-build.ts <workspaceSlug> <briefFile> [--build id] [--new-build] [--app-slug s] [--retries n] [--budget-min m] [--allow-fallback] [--cleanup] [--dry-run] [--bench n] [--concurrency c] [--verify [--verify-rounds n]]");
    process.exit(64);
  }
  const num = (k: string, d: number) => (flags.has(k) ? Number(flags.get(k)) : d);
  return {
    slug: pos[0], briefFile: pos[1] ?? "", build: flags.get("build") as string | undefined,
    newBuild: flags.has("new-build"), appSlug: flags.get("app-slug") as string | undefined,
    retries: num("retries", 3), budgetMs: num("budget-min", 30) * 60_000,
    allowFallback: flags.has("allow-fallback"), cleanup: flags.has("cleanup"),
    dryRun: flags.has("dry-run") || flags.has("bench"), bench: num("bench", 0), concurrency: Math.max(1, num("concurrency", 1)),
    base: (flags.get("base") as string) ?? "http://localhost:3100", out: flags.get("out") as string | undefined,
    verify: flags.has("verify") || flags.has("verify-only"), verifyOnly: flags.has("verify-only"), verifyRounds: Math.max(1, num("verify-rounds", 3)),
    verifyLocales: typeof flags.get("verify-locales") === "string" ? (flags.get("verify-locales") as string).split(",") : ["en", "th", "zh"],
    verifyIterate: !flags.has("verify-no-iterate"), verifyRegen: Math.max(1, num("verify-regen", 1)),
    allowMissing: flags.has("allow-missing"), stepTokens: Math.max(5_000, num("step-tokens", 150_000)),
  };
}

// ── small utils ──────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`;
const log = (...a: unknown[]) => console.error(stamp(), ...a);
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
/** A refusal no retry fixes (the provider account or the workspace's AI credits are used up). */
const isFatal = (text: string) => /run out of credit|used its AI credits|insufficient balance|AI_CREDITS_EXHAUSTED|suspended/i.test(text);
const backoff = (n: number) => Math.min(5_000 * 2 ** (n - 1), 60_000);

class Budget {
  constructor(private deadline: number) {}
  left() { return this.deadline - Date.now(); }
  check(what: string) { if (this.left() <= 0) throw new StepFailed(what, "overall time budget spent"); }
}
class StepFailed extends Error { constructor(public stage: string, public reason: string) { super(`${stage}: ${reason}`); } }

// ── HTTP session (dev admin) ─────────────────────────────────────────

class Session {
  private cookies = new Map<string, string>();
  constructor(private base: string, private agent: any, private undiciFetch: typeof fetch) {}
  private cookieHeader() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "); }
  private store(res: Response) {
    for (const c of (res.headers as any).getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  async req(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.undiciFetch(this.base + path, {
      ...init, redirect: "manual", dispatcher: this.agent,
      headers: { ...(init.headers as Record<string, string>), cookie: this.cookieHeader() },
    } as any);
    this.store(res);
    return res;
  }
  /** `patient`: a read that waits out a server restart (connection refused/reset) for up to 5 minutes instead of failing the run. */
  async json(path: string, init: RequestInit = {}, patient = false): Promise<{ status: number; body: any }> {
    let res: Response;
    for (let tries = 0; ; tries++) {
      try { res = await this.req(path, init); break; }
      catch (e: any) {
        if (!patient || tries >= 60) throw e;
        if (tries === 0) log(`server not answering (${e?.cause?.code ?? e?.message}) — waiting for it…`);
        await sleep(5_000);
      }
    }
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
    return { status: res.status, body };
  }
  post(path: string, payload: unknown) {
    return this.json(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  }
  async login(slug: string): Promise<{ tenantId: string; userId: string }> {
    // Dev credentials from CLAUDE.md (seeded by `npm run db:seed`).
    const email = process.env.MB_EMAIL ?? "admin@curf.local";
    const password = process.env.MB_PASSWORD ?? "admin123";
    const csrf = (await this.json("/api/auth/csrf")).body?.csrfToken;
    if (!csrf) throw new Error("no csrf token — is the server up?");
    await this.req("/api/auth/callback/credentials", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken: csrf, email, password, json: "true" }),
    });
    const s = (await this.json("/api/auth/session")).body;
    const m = s?.user?.memberships?.find((x: any) => x.tenantSlug === slug);
    if (!s?.user) throw new Error("sign-in failed (seed the database: npm run db:seed)");
    if (!m) throw new Error(`the dev admin has no membership in workspace "${slug}"`);
    const csrf2 = (await this.json("/api/auth/csrf")).body?.csrfToken;
    await this.post("/api/auth/session", { csrfToken: csrf2, data: { activeTenantId: m.tenantId } });
    const after = (await this.json("/api/auth/session")).body;
    if (after?.user?.tenantId !== m.tenantId) throw new Error("could not switch to the workspace");
    return { tenantId: m.tenantId, userId: after.user.id };
  }
}

async function openSession(base: string): Promise<{ make: () => Session }> {
  const u = await import("undici");
  // No client-side headers/body timeout: the server bounds every call, and a long
  // synchronous iterate must not be cut by the client's own 300s default.
  const agent = new u.Agent({ headersTimeout: 0, bodyTimeout: 0, connections: 8 });
  return { make: () => new Session(base, agent, u.fetch as any) };
}

// ── LLM stats from the usage log ─────────────────────────────────────

type CallStat = { kind: string; n: number; ok: number; failed: number; retriedAway: number; p50s: number | null; p95s: number | null; maxS: number | null; inTok: number; outTok: number; errors: Record<string, number> };

async function llmStats(tenantId: string, since: Date): Promise<{ calls: CallStat[]; total: number; failed: number }> {
  await sleep(1500); // usage rows are written after the response (setImmediate)
  const rows = await prisma.llmTokenUsage.findMany({ where: { tenantId, createdAt: { gte: since } }, orderBy: { createdAt: "asc" } });
  const by = new Map<string, typeof rows>();
  for (const r of rows) (by.get(r.kind) ?? by.set(r.kind, []).get(r.kind)!).push(r);
  const calls: CallStat[] = [];
  for (const [kind, rs] of by) {
    const d = rs.map((r) => (r.durationMs ?? 0) / 1000);
    const errors: Record<string, number> = {};
    for (const r of rs) if (r.status !== "ok") errors[r.errorKind ?? "unknown"] = (errors[r.errorKind ?? "unknown"] ?? 0) + 1;
    calls.push({
      kind, n: rs.length, ok: rs.filter((r) => r.status === "ok").length, failed: rs.filter((r) => r.status !== "ok").length,
      retriedAway: 0, p50s: pct(d, 0.5), p95s: pct(d, 0.95), maxS: d.length ? Math.max(...d) : null,
      inTok: rs.reduce((a, r) => a + r.inputTokens, 0), outTok: rs.reduce((a, r) => a + r.outputTokens, 0), errors,
    });
  }
  return { calls: calls.sort((a, b) => b.n - a.n), total: rows.length, failed: rows.filter((r) => r.status !== "ok").length };
}

// ── steps ────────────────────────────────────────────────────────────

type Timing = {
  step: string; seconds: number; attempts: number; note?: string;
  /** Credit the step spent (from the usage log), and whether it spent some and changed nothing. */
  tokensIn?: number; tokensOut?: number; changedNothing?: boolean;
  /** An apply: reports it was asked for / still outstanding after it. */
  wanted?: number; outstanding?: number;
  /** An iterate: what the server said the step cost (calls, chunks, tokens). */
  usage?: unknown;
  startedAt?: number; endedAt?: number;
};
type Summary = Record<string, any>;

async function newestBuild(s: Session, tenantId: string, wanted?: string) {
  const b = await (prisma as any).masterBuild.findFirst({
    where: wanted ? { id: wanted, tenantId } : { tenantId, status: "ready" }, orderBy: { startedAt: "desc" },
  });
  if (!b) throw new Error(wanted ? `build ${wanted} not found in this workspace` : "the workspace has no ready Master Builder build — pass --new-build or --build <id>");
  return b;
}

/** Step 1 (iterate): brief -> change plan. Retried on a model failure. */
async function iterateStep(s: Session, o: Opts, budget: Budget, buildId: string, brief: string, timings: Timing[]) {
  for (let attempt = 1; attempt <= o.retries + 1; attempt++) {
    budget.check("iterate");
    const t = Date.now();
    log(`iterate (attempt ${attempt}) — asking the model for a change plan…`);
    // The server holds the step to a wall-clock and a token budget (and caps what is asked of it here).
    const r = await s.post("/api/master-builder/iterate", { buildId, prompt: brief, budgetMs: Math.min(budget.left(), 8 * 60_000), tokenBudget: o.stepTokens });
    const secs = (Date.now() - t) / 1000;
    if (r.status === 200 && r.body?.proposedMessageId) {
      timings.push({ step: "iterate", seconds: secs, attempts: attempt, usage: r.body.usage });
      if (r.body.briefProblems?.length) log(`iterate: the plan does not cover: ${r.body.briefProblems.join("; ")}`);
      return { messageId: r.body.proposedMessageId as string, delta: r.body.delta, briefProblems: (r.body.briefProblems ?? []) as string[] };
    }
    const cost = r.body?.usage ? ` (${r.body.usage.calls} model call(s), ${r.body.usage.inputTokens} in / ${r.body.usage.outputTokens} out)` : "";
    timings.push({ step: "iterate", seconds: secs, attempts: attempt, note: `HTTP ${r.status}: ${String(r.body?.error ?? "").slice(0, 160)}`, usage: r.body?.usage });
    log(`iterate failed after ${secs.toFixed(0)}s: HTTP ${r.status} ${String(r.body?.error ?? "").slice(0, 200)}${cost}`);
    if (isFatal(String(r.body?.error ?? ""))) throw new StepFailed("iterate", String(r.body?.error ?? "").split("\n")[0]);
    // A 502 is the model failing to produce a plan after the server already retried with a CHANGED request (a smaller
    // scope, a terser one, more room). The identical request is not sent again: it cost ~8 minutes and ~100k tokens each time.
    if (r.status === 502) throw new StepFailed("iterate", `${String(r.body?.error ?? `HTTP ${r.status}`).split("\n")[0]}${cost}`);
    if (r.status === 429) await sleep(20_000);
    else if (r.status >= 400 && r.status < 500) throw new StepFailed("iterate", `HTTP ${r.status}: ${r.body?.error ?? "rejected"}`);
    if (attempt > o.retries) throw new StepFailed("iterate", String(r.body?.error ?? `HTTP ${r.status}`).split("\n")[0]);
    await sleep(backoff(attempt));
  }
  throw new StepFailed("iterate", "unreachable");
}

/** Poll a proposed message until its apply finishes; prints a heartbeat. */
async function waitApplied(s: Session, budget: Budget, buildId: string, messageId: string): Promise<string> {
  let lastBeat = 0;
  const began = Date.now();
  for (;;) {
    budget.check("apply");
    const r = await s.json(`/api/master-builder/${buildId}`, {}, true);
    const msg = (r.body?.messages ?? []).find((m: any) => m.id === messageId);
    const st = msg?.planStatus;
    if (st && st !== "applying") return st;
    if (Date.now() - lastBeat > 15_000) {
      lastBeat = Date.now();
      log(`apply running… ${Math.round((Date.now() - began) / 1000)}s`);
    }
    await sleep(4_000);
  }
}

type ReportOutcome = { name: string; state: "ok" | "fallback" | "failed" | "missing"; refId?: string; note?: string };

async function reportOutcomes(buildId: string, wanted: string[], since: Date): Promise<ReportOutcome[]> {
  const arts = await (prisma as any).masterBuildArtifact.findMany({ where: { buildId, kind: "report", createdAt: { gte: since } }, orderBy: { createdAt: "asc" } });
  return wanted.map((name) => {
    // A name the workspace already held is built as "name (2)": same report, numbered.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const numbered = new RegExp(`^${escaped} \\(\\d+\\)$`);
    const mine = arts.filter((a: any) => a.name === name || numbered.test(a.name));
    const good = [...mine].reverse().find((a: any) => a.status === "ok" && a.provenance !== "deleted");
    if (good) {
      const note = good.errorMessage ?? undefined;
      return { name, state: /Simplified:/.test(note ?? "") ? "fallback" : "ok", refId: good.refId ?? undefined, note } as ReportOutcome;
    }
    const bad = [...mine].reverse().find((a: any) => a.status === "failed");
    return { name, state: bad ? "failed" : "missing", note: bad?.errorMessage ?? undefined } as ReportOutcome;
  });
}

/** Steps 2+3: apply (background, strict), then resume only what did not land. */
async function applyStep(s: Session, o: Opts, budget: Budget, tenantId: string, buildId: string, messageId: string, delta: any, since: Date, timings: Timing[]) {
  const wanted: string[] = (delta?.add?.reports ?? []).map((r: any) => r.name);
  let pending = delta;
  let outcomes: ReportOutcome[] = [];
  for (let attempt = 1; attempt <= o.retries + 1; attempt++) {
    budget.check("apply");
    const t = Date.now();
    const first = attempt === 1;
    log(`apply (attempt ${attempt}) — ${(pending?.add?.reports ?? []).length} report(s) to build${o.allowFallback ? "" : ", strict (no Simplified fallback)"}`);
    const start = await s.post("/api/master-builder/apply", first
      ? { buildId, proposedMessageId: messageId, background: true, strictAi: !o.allowFallback }
      : { buildId, delta: pending, background: true, strictAi: !o.allowFallback });
    if (start.status !== 202) throw new StepFailed("apply", `HTTP ${start.status}: ${start.body?.error ?? "rejected"}`);
    // A resume applies a bare delta (no proposal to watch): wait on the outcome message instead.
    let state: string;
    if (first) state = await waitApplied(s, budget, buildId, messageId);
    else state = await waitForNewOutcome(s, budget, buildId, t);
    const secs = (Date.now() - t) / 1000;
    outcomes = await reportOutcomes(buildId, wanted, since);
    const missing = outcomes.filter((x) => x.state === "failed" || x.state === "missing" || (!o.allowFallback && x.state === "fallback"));
    timings.push({ step: "apply", seconds: secs, attempts: attempt, note: `${state}; ${missing.length} report(s) outstanding`, wanted: wanted.length, outstanding: missing.length });
    if (state === "proposed") log("the apply threw and the proposal was handed back");
    // An apply that returned in seconds and produced nothing for ANY report did not try: it was refused, and the same
    // request is refused the same way. Say why instead of resuming it unchanged (it was resumed three times).
    if (applyDidNoWork({ seconds: secs, wanted: wanted.length, outcomes })) {
      const cause = applyCauseFromMessage(await lastApplyMessage(s, buildId, t));
      throw new StepFailed("apply", `did no work in ${secs.toFixed(0)}s (${missing.length} of ${wanted.length} report(s) outstanding): ${cause}`);
    }
    if (missing.length === 0 || wanted.length === 0) return outcomes;
    if (attempt > o.retries) return outcomes;
    if (missing.every((m) => isFatal(m.note ?? ""))) { log("the provider is refusing every request (credit) — not retrying"); return outcomes; }
    log(`resuming only: ${missing.map((m) => m.name).join(", ")}`);
    const names = new Set(missing.map((m) => m.name));
    pending = {
      ...delta,
      add: { tables: [], watchers: [], operateTemplates: [], reports: (delta.add.reports ?? []).filter((r: any) => names.has(r.name)) },
      remove: (delta.remove ?? []).filter((x: any) => x?.ref?.kind === "report" && names.has(x.ref.name)),
      modify: [], cascades: [], conflicts: [],
    };
    await sleep(backoff(attempt));
  }
  return outcomes;
}

/** The build journal's newest outcome message written since `since` (an apply's own report of what it did). */
async function lastApplyMessage(s: Session, buildId: string, since: number): Promise<string | null> {
  const r = await s.json(`/api/master-builder/${buildId}`, {}, true);
  const msgs: any[] = r.body?.messages ?? [];
  const m = msgs.filter((x) => x.role === "assistant" && /^applied/.test(x.planStatus ?? "") && new Date(x.createdAt ?? 0).getTime() >= since - 2000).pop();
  return m?.content ?? null;
}

async function waitForNewOutcome(s: Session, budget: Budget, buildId: string, since: number): Promise<string> {
  let lastBeat = 0;
  for (;;) {
    budget.check("apply");
    const r = await s.json(`/api/master-builder/${buildId}`, {}, true);
    const msgs: any[] = r.body?.messages ?? [];
    const out = msgs.filter((m) => m.role === "assistant" && /^applied/.test(m.planStatus ?? "") && new Date(m.createdAt ?? m.appliedAt ?? 0).getTime() >= since - 2000).pop();
    if (out) return out.planStatus;
    if (Date.now() - lastBeat > 15_000) { lastBeat = Date.now(); log(`resume apply running… ${Math.round((Date.now() - since) / 1000)}s`); }
    await sleep(4_000);
  }
}

/** New-build mode: plan job (resumed from its last good stage) -> background first-build apply. */
async function newBuildStep(s: Session, o: Opts, budget: Budget, tenantId: string, brief: string, timings: Timing[], summary: Summary) {
  let resumeFromJobId: string | undefined;
  let plan: any = null;
  for (let attempt = 1; attempt <= o.retries + 1 && !plan; attempt++) {
    budget.check("plan");
    const t = Date.now();
    const start = await s.post("/api/master-builder/plan", { prompt: brief, ...(resumeFromJobId ? { resumeFromJobId } : {}) });
    if (start.status !== 202) {
      if (start.body?.plan) { plan = start.body.plan; timings.push({ step: "plan", seconds: (Date.now() - t) / 1000, attempts: attempt, note: "archetype (no model)" }); break; }
      throw new StepFailed("plan", `HTTP ${start.status}: ${start.body?.error ?? "rejected"}`);
    }
    const jobId = start.body.jobId as string;
    log(`plan job ${jobId} (attempt ${attempt}${resumeFromJobId ? ", resuming from its last good stage" : ""})`);
    let lastBeat = 0, lastStage = "";
    for (;;) {
      budget.check("plan");
      const j = (await s.json(`/api/ai-jobs/${jobId}`, {}, true)).body;
      if (j.stage !== lastStage || Date.now() - lastBeat > 20_000) { lastStage = j.stage; lastBeat = Date.now(); log(`plan: ${j.stage} (${j.progressPct}%)`); }
      if (j.status === "done") { plan = j.result?.plan; summary.planEvents = j.events; break; }
      if (j.status === "failed") {
        summary.planEvents = j.events;
        timings.push({ step: "plan", seconds: (Date.now() - t) / 1000, attempts: attempt, note: String(j.error ?? "").split("\n")[0].slice(0, 160) });
        log(`plan failed: ${String(j.error ?? "").split("\n")[0]}`);
        if (attempt > o.retries || isFatal(String(j.error ?? ""))) throw new StepFailed("plan", String(j.error ?? "failed").split("\n")[0]);
        if (j.completedStages) { resumeFromJobId = jobId; log(`stages kept: ${Object.keys(j.completedStages).join(", ")}`); }
        await sleep(backoff(attempt));
        break;
      }
      await sleep(5_000);
    }
    if (plan) timings.push({ step: "plan", seconds: (Date.now() - t) / 1000, attempts: attempt });
  }
  if (!plan) throw new StepFailed("plan", "no plan");
  summary.plan = {
    tables: plan.tables?.length, reports: (plan.reports ?? []).map((r: any) => r.name), reportCount: (plan.reports ?? []).length,
    app: plan.app?.name, whatIf: !!plan.app?.whatIf,
  };
  const c = extractBriefConstraints(brief);
  if (hasDeliveryAsks(c) || c.existingTablesOnly || c.fiscalYears.length) {
    // What the plan carries of what the brief asked, before a single report is built.
    const found = validatePlanAgainstBriefSplit(plan, c, null);
    summary.briefPlan = {
      askedTabs: c.tabCount, askedReports: expectedReportCount(c), plannedReports: (plan.reports ?? []).length,
      askedChartKinds: c.chartKinds, askedWhatIf: c.requireWhatIf, plannedWhatIf: !!plan.app?.whatIf,
      fiscalYear: c.primaryFiscalYear, kpiTargets: c.kpiTargets, askedKpis: c.kpis.map((k) => k.name),
      problems: [...found.hard, ...found.soft], missingAsks: found.asks,
    };
  }
  return plan;
}


// ── verify and repair ────────────────────────────────────────────────

type Round = { round: number; seconds: number; byKind: Record<string, number>; bySeverity: Record<string, number>; deterministic?: any[]; iterate?: any };

/**
 * Round 0 verifies; each repair round then (1) applies what code can fix through the gate, (2) sends what needs
 * judgement to Master Builder as a repair brief (iterate -> strict apply), (3) verifies again. Stops when nothing
 * is left at warn or above, when a round leaves the same findings, or when the rounds are spent.
 */
async function verifyLoop(s: Session, o: Opts, budget: Budget, tenantId: string, userId: string, buildId: string | undefined, timings: Timing[]) {
  const { verifyApp } = await import("./mb-verify/browser");
  const { repairDeterministic } = await import("./mb-verify/repair");
  const { atLeast, countByKind, countBySeverity, findingKey } = await import("../src/lib/master-builder/verify/types");
  const { buildRepairBrief } = await import("../src/lib/master-builder/verify/repairBrief");
  const { startRepairGuard } = await import("./mb-verify/guard");
  const { repairDeadWhatIf } = await import("../src/lib/master-builder/whatIfRepair");
  const { DEFAULT_ALLOWED_WORDS } = await import("../src/lib/master-builder/verify/text");
  const check = () => verifyApp({ base: o.base, workspace: o.slug, appSlug: o.appSlug!, locales: o.verifyLocales as any, allowWords: DEFAULT_ALLOWED_WORDS, drill: true, whatIf: true, hover: true, log });
  const rounds: Round[] = [];
  const fixed: any[] = [];
  const iterated: any[] = [];
  const guarded: any[] = [];
  /** Findings the guard raised (repair-reverted...) after an iterate step: they join the next round's list. */
  let carried: any[] = [];
  let result = await timed(timings, "verify", check);
  const record = (round: number, extra: Partial<Round> = {}) => rounds.push({ round, seconds: result.seconds, byKind: countByKind(result.findings, "warn"), bySeverity: countBySeverity(result.findings.filter((f) => atLeast(f, "warn"))), ...extra });
  record(0);
  const regens = new Map<string, number>();
  let stopped = "rounds spent";
  let prev: Set<string> | null = null;
  for (let round = 1; round <= o.verifyRounds; round++) {
    const open = [...result.findings, ...carried].filter((f) => atLeast(f, "warn"));
    carried = [];
    if (open.length === 0) { stopped = "clean"; break; }
    // kpi-no-drill is only "info" but has a working autofix: it rides along with the warn-level repairs.
    const infoFixable = result.findings.filter((f) => f.kind === "kpi-no-drill" && f.suggestedFix.autofix && !open.includes(f));
    // Ids change when Master Builder regenerates a report, so progress is judged by what is wrong where, not by block id.
    const keys = new Set(open.map((f) => `${f.kind}|${f.tab}|${f.locale}|${f.blockTitle ?? ""}`));
    if (prev && keys.size === prev.size && [...keys].every((k) => prev!.has(k))) { stopped = "no progress"; break; }
    prev = keys;
    budget.check("verify");
    log(`verify round ${round}: ${open.length} finding(s) at warn or above — ${JSON.stringify(countByKind(open))}`);

    // A report Master Builder will regenerate is not repaired by code first: regenerating discards the edits (a Thai
    // build's new report comes back with no English text), so code takes the reports MB does not touch, and the
    // next round (or the finishing pass) takes the regenerated ones. A report is regenerated at most --verify-regen
    // times: a design the model did not get right in one go is reported, not asked for again and again.
    const nameOf = (id?: string) => (id ? result.reportNames[id] ?? id : "");
    const needsJudgement = new Set(open.filter((f) => !f.suggestedFix.autofix && f.reportId && (regens.get(nameOf(f.reportId)) ?? 0) < o.verifyRegen).map((f) => f.reportId!));
    const regenerate = o.verifyIterate && !!buildId ? needsJudgement : new Set<string>();
    const t = Date.now();
    const outcomes = await repairDeterministic({ tenantId, userId, findings: [...open, ...infoFixable].filter((f) => !regenerate.has(f.reportId ?? "")), translate: true, appSlug: o.appSlug, log });
    const det = outcomes.map((r) => ({ report: r.name, saved: r.saved, fixes: r.applied.map((a) => `${a.action}: ${a.detail}`), translated: r.translated, note: r.note }));
    fixed.push(...det.filter((d) => d.saved));
    timings.push({ step: `repair-${round}`, seconds: (Date.now() - t) / 1000, attempts: 1, note: `${outcomes.filter((r) => r.saved).length} report(s) saved` });

    // 2. What needs judgement: the reports with a finding code does not own, and what code could not clear.
    const unresolved = new Set(outcomes.flatMap((r) => r.unresolved.map(findingKey)));
    if (o.verifyIterate && buildId) for (const f of open) if (unresolved.has(findingKey(f)) && f.reportId && (regens.get(nameOf(f.reportId)) ?? 0) < o.verifyRegen) regenerate.add(f.reportId);
    const judgement = open.filter((f) => regenerate.has(f.reportId ?? "") || (!f.suggestedFix.autofix && !f.reportId));
    let it: any = undefined;
    if (o.verifyIterate && judgement.length && buildId) {
      const brief = buildRepairBrief(judgement, { reportNames: result.reportNames });
      if (brief.text) {
        const since = new Date();
        // What each report holds now, so what the regeneration drops can be put back (and the brief says what must stay).
        const guard = await startRepairGuard({ tenantId, userId, appSlug: o.appSlug!, log });
        const briefWithKeep = buildRepairBrief(judgement, { reportNames: result.reportNames, preserve: guard.preserve });
        log(`asking Master Builder to repair ${brief.reports.length} report(s): ${brief.reports.map((r) => r.name).join(", ")}`);
        try {
          const step = await iterateStep(s, o, budget, buildId, briefWithKeep.text || brief.text, timings);
          const outcomes2 = await applyStep(s, o, budget, tenantId, buildId, step.messageId, step.delta, since, timings);
          it = { reports: brief.reports.map((r) => r.name), lines: brief.reports.reduce((n, r) => n + r.lines.length, 0), outcomes: outcomes2.map((x) => ({ name: x.name, state: x.state, note: x.note?.slice(0, 160) })) };
          iterated.push(it);
          const g = await guard.settle();
          carried.push(...g.findings);
          guarded.push(...g.outcomes.filter((x) => x.action !== "ok"));
          it.guard = g.outcomes.filter((x) => x.action !== "ok").map((x) => ({ report: x.name, action: x.action, lost: x.losses, restored: x.restored }));
          for (const r of brief.reports) regens.set(r.name, (regens.get(r.name) ?? 0) + 1);
        } catch (e: any) { it = { error: e?.message ?? String(e) }; log(`iterate repair failed: ${it.error}`); }
      }
    }
    // 3. Look again — unless nothing was changed: the same app would be measured to the same result.
    if (det.every((d) => !d.saved) && !it) { record(round, { deterministic: det }); stopped = "nothing more code or Master Builder can change"; break; }
    result = await timed(timings, "verify", check);
    record(round, { deterministic: det, iterate: it });
  }
  // A What-if tab that still does not resolve (apply already re-binds after a regeneration; the verifier's own
  // --repair is not part of this loop): rebind or rebuild it once, then look again.
  let whatIfRepair: any = undefined;
  if (result.findings.some((f) => f.kind === "whatif-dead")) {
    budget.check("verify");
    const app: any = await (prisma as any).app.findFirst({ where: { tenantId, slug: o.appSlug }, select: { id: true } });
    if (app) {
      whatIfRepair = await repairDeadWhatIf({ tenantId, appId: app.id }).catch((e: any) => ({ repaired: false, mode: "none", note: e?.message ?? String(e) }));
      log(`what-if repair: ${whatIfRepair.mode} - ${whatIfRepair.note}`);
      if (whatIfRepair.repaired) { result = await timed(timings, "verify", check); record(rounds.length, { deterministic: [] }); }
    }
  }
  // The last round may have regenerated reports: give code a final pass over what it owns on the new ones.
  const lastRound = rounds[rounds.length - 1];
  const finishable = result.findings.filter((f) => (atLeast(f, "warn") || f.kind === "kpi-no-drill") && f.suggestedFix.autofix);
  if (lastRound?.iterate && finishable.length) {
    budget.check("verify");
    log(`finishing pass: ${finishable.length} finding(s) code can fix on the regenerated report(s)`);
    const outcomes = await repairDeterministic({ tenantId, userId, findings: finishable, translate: true, appSlug: o.appSlug, log });
    const det = outcomes.map((r) => ({ report: r.name, saved: r.saved, fixes: r.applied.map((a) => `${a.action}: ${a.detail}`), translated: r.translated, note: r.note }));
    fixed.push(...det.filter((d) => d.saved));
    result = await timed(timings, "verify", check);
    record(rounds.length, { deterministic: det });
  }
  if (stopped === "rounds spent" && result.findings.every((f) => !atLeast(f, "warn"))) stopped = "clean";
  const remaining = [...result.findings, ...carried].filter((f) => atLeast(f, "warn"));
  return {
    rounds, stopped, deterministicFixes: fixed, iterate: iterated, whatIfRepair,
    guard: summariseGuard(guarded),
    remainingBySeverity: countBySeverity(remaining), remainingByKind: countByKind(remaining),
    remaining: remaining.slice(0, 40).map((f) => ({ severity: f.severity, kind: f.kind, tab: f.tab, locale: f.locale, block: f.blockTitle, detail: f.detail.slice(0, 200), fix: f.suggestedFix.text.slice(0, 160) })),
    fallbacks: iterated.flatMap((i) => (i.outcomes ?? []).filter((x: any) => x.state === "fallback").map((x: any) => x.name)),
  };
}

/** Stamp every step as it is recorded, so the credit it spent can be read back from the usage log afterwards. */
function stampTimings(timings: Timing[]) {
  const push = timings.push.bind(timings);
  timings.push = (...items: Timing[]) => {
    const now = Date.now();
    for (const it of items) { it.endedAt = now; it.startedAt = now - Math.round(it.seconds * 1000); }
    return push(...items);
  };
}

/** Tokens in/out per step (from the usage log, by the step's time window), and which steps changed nothing. */
async function annotateSpend(tenantId: string, since: Date, timings: Timing[]) {
  await sleep(1500); // usage rows are written after the response (setImmediate)
  const rows = await prisma.llmTokenUsage.findMany({ where: { tenantId, createdAt: { gte: since } }, select: { createdAt: true, inputTokens: true, outputTokens: true } }).catch(() => []);
  const steps = timings.filter((t) => t.startedAt !== undefined && t.endedAt !== undefined);
  steps.sort((a, b) => a.startedAt! - b.startedAt!);
  steps.forEach((t, i) => {
    const from = t.startedAt! - 300;
    const to = Math.min(t.endedAt! + 2000, steps[i + 1] ? steps[i + 1]!.startedAt! - 1 : Infinity);
    const mine = rows.filter((r) => r.createdAt.getTime() >= from && r.createdAt.getTime() <= to);
    t.tokensIn = mine.reduce((a, r) => a + r.inputTokens, 0);
    t.tokensOut = mine.reduce((a, r) => a + r.outputTokens, 0);
  });
  for (const t of timings) {
    if (stepChangedNothing(t)) t.changedNothing = true;
    delete t.startedAt; delete t.endedAt;
  }
  const spent = timings.reduce((a, t) => ({ inputTokens: a.inputTokens + (t.tokensIn ?? 0), outputTokens: a.outputTokens + (t.tokensOut ?? 0) }), { inputTokens: 0, outputTokens: 0 });
  const wasted = timings.filter((t) => t.changedNothing).reduce((a, t) => a + (t.tokensIn ?? 0) + (t.tokensOut ?? 0), 0);
  return { ...spent, spentOnStepsThatChangedNothing: wasted };
}

type LocatedApp = BuiltAppRow;

/**
 * The app this run built, found by the id the build produced (never by slug: a slug can name an OLDER app). A new
 * build's app is renamed to --app-slug when that slug is free; when another app holds it the produced app keeps its
 * own slug and the collision is reported (MB_SUMMARY.app.requestedSlug / actualSlug / slugCollision).
 */
async function locateApp(tenantId: string, buildId: string | undefined, o: Opts, createdByThisRun: boolean, appId?: string | null, buildStartedAt?: Date) {
  const db = prisma as any;
  const pick = { id: true, slug: true, title: true, viewsJson: true, createdAt: true };
  const appDb: BuiltAppDb = {
    byId: (id) => db.app.findFirst({ where: { id, tenantId }, select: pick }).catch(() => null),
    bySlug: (slug) => db.app.findFirst({ where: { tenantId, slug }, select: pick }).catch(() => null),
    appIdOfBuild: async (id) => {
      const arts = await db.masterBuildArtifact.findMany({ where: { buildId: id, kind: "app" }, orderBy: { createdAt: "desc" } }).catch(() => []);
      return arts.find((a: any) => a.provenance !== "deleted" && a.refId)?.refId ?? null;
    },
    slugTaken: (slug, exceptId) => isAppSlugTaken(slug, { exceptAppId: exceptId }),
    rename: async (id, slug) => { await db.app.updateMany({ where: { id, tenantId }, data: { slug } }); },
  };
  const r = await locateBuiltApp(appDb, { appId, buildId, requestedSlug: o.appSlug, createdByThisRun, buildStartedAt });
  if (r.renamedFrom) log(`app slug "${r.renamedFrom}" -> "${r.slug.actual}" (--app-slug)`);
  if (r.slug.collision) log(`--app-slug "${r.slug.requested}" is held by another app: the produced app keeps its own slug "${r.slug.actual}"`);
  return r;
}

const hasDeliveryAsks = (c: BriefConstraints) => c.requireWhatIf || c.tabCount !== null || c.chartKinds.length > 0 || c.kpis.length > 0;

/** What the brief asked for against what the app (by id) holds now. */
async function measureDelivery(tenantId: string, c: BriefConstraints, appId: string | undefined) {
  const app: any = appId ? await (prisma as any).app.findFirst({ where: { id: appId, tenantId }, select: { viewsJson: true } }).catch(() => null) : null;
  const views = (safeParse(app?.viewsJson) ?? []) as any[];
  const ids = views.filter((v) => v.kind === "report" && v.reportId).map((v) => v.reportId as string);
  const rows = ids.length ? await prisma.report.findMany({ where: { id: { in: ids }, tenantId }, select: { definition: true } }).catch(() => []) : [];
  return evaluateBriefDelivery(c, builtAppFacts(views, (rows as any[]).map((r) => safeParse(r.definition))));
}

async function timed<T>(timings: Timing[], step: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  const r = await fn();
  timings.push({ step, seconds: (Date.now() - t) / 1000, attempts: 1 });
  return r;
}

// ── main ─────────────────────────────────────────────────────────────

async function oneRun(o: Opts, brief: string, make: () => Session, tenantId: string): Promise<Summary> {
  const started = new Date();
  const budget = new Budget(Date.now() + o.budgetMs);
  const timings: Timing[] = [];
  stampTimings(timings);
  const summary: Summary = { workspace: o.slug, mode: o.newBuild ? "new-build" : "chat-step", startedAt: started.toISOString(), timings };
  const constraints = extractBriefConstraints(brief);
  let located: Awaited<ReturnType<typeof locateApp>> = { app: null, slug: { requested: o.appSlug ?? null, actual: null, collision: false } };
  let producedAppId: string | null = null;
  let deliveryBefore: ReturnType<typeof evaluateBriefDelivery> | null = null;
  const s = make();
  const { tenantId: tid, userId } = await s.login(o.slug);
  if (o.verify && !o.appSlug && !o.newBuild) throw new Error("--verify needs --app-slug <the app to open> (or --new-build, which opens the app it built)");
  let state = "failed", exit = 1;
  let createdBuildId: string | null = null;
  let restore: any = null;
  // Ctrl-C / SIGTERM: say so, and clean up what this run added when --cleanup (or a dry run) asked for it.
  const onSignal = async (sig: string) => {
    log(`${sig} — stopping; cleaning up what this run added`);
    try {
      if (o.dryRun && restore) await (prisma as any).masterBuildMessage.deleteMany({ where: { buildId: restore.id, tenantId: tid, createdAt: { gte: started } } });
      else if (o.cleanup) await cleanup(tid, started, restore, createdBuildId, s);
    } catch { /* best effort */ }
    process.exit(130);
  };
  process.once("SIGINT", () => void onSignal("SIGINT"));
  process.once("SIGTERM", () => void onSignal("SIGTERM"));
  try {
    if (o.verifyOnly) {
      const build = await newestBuild(s, tid, o.build);
      summary.buildId = build.id;
      restore = { id: build.id, version: build.version, status: build.status, planJson: build.planJson, statusJson: build.statusJson, lastIteratedAt: build.lastIteratedAt, summary: build.summary };
      state = "built"; exit = 0;
    } else if (o.newBuild) {
      const plan = await newBuildStep(s, o, budget, tid, brief, timings, summary);
      if (o.dryRun) { state = "built"; summary.dryRun = true; exit = 0; }
      else {
        const t = Date.now();
        const a = await s.post("/api/master-builder/apply", { plan, background: true, strictAi: !o.allowFallback });
        if (a.status !== 201) throw new StepFailed("apply", `HTTP ${a.status}: ${a.body?.error ?? "rejected"}`);
        createdBuildId = a.body.buildId;
        summary.buildId = createdBuildId;
        let lastBeat = 0;
        for (;;) {
          budget.check("build");
          const r = (await s.json(`/api/master-builder/${createdBuildId}`, {}, true)).body;
          const st = r?.build?.status;
          if (Date.now() - lastBeat > 15_000) { lastBeat = Date.now(); log(`build ${st}: ${r?.build?.progress?.stage ?? ""} ${r?.build?.progress?.currentName ?? ""} ${r?.build?.progress?.done ?? ""}/${r?.build?.progress?.total ?? ""}`); }
          if (st && st !== "building") {
            timings.push({ step: "build", seconds: (Date.now() - t) / 1000, attempts: 1, note: st });
            // The app this build produced, by id: every later step (rename, delivery check, verify) uses it, never a slug lookup.
            producedAppId = (r.artifacts ?? []).filter((x: any) => x.kind === "app" && x.status === "ok" && x.refId && x.provenance !== "deleted").pop()?.refId ?? null;
            const reps = (r.artifacts ?? []).filter((x: any) => x.kind === "report");
            summary.reports = reps.map((x: any) => ({ name: x.name, state: x.status !== "ok" ? "failed" : /Simplified:/.test(x.errorMessage ?? "") ? "fallback" : "ok", refId: x.refId, note: x.errorMessage }));
            break;
          }
          await sleep(5_000);
        }
      }
    } else {
      const build = await newestBuild(s, tid, o.build);
      summary.buildId = build.id;
      restore = { id: build.id, version: build.version, status: build.status, planJson: build.planJson, statusJson: build.statusJson, lastIteratedAt: build.lastIteratedAt, summary: build.summary };
      const { messageId, delta } = await iterateStep(s, o, budget, build.id, brief, timings);
      summary.plan = {
        addReports: (delta?.add?.reports ?? []).map((r: any) => r.name), addTables: delta?.add?.tables?.length ?? 0,
        addWatchers: delta?.add?.watchers?.length ?? 0, remove: delta?.remove?.length ?? 0, modify: delta?.modify?.length ?? 0,
      };
      if (o.dryRun) { state = "built"; summary.dryRun = true; exit = 0; }
      else {
        const additive = (delta?.remove?.length ?? 0) === 0 && (delta?.modify?.length ?? 0) === 0
          && (delta?.add?.tables?.length ?? 0) === 0 && (delta?.add?.watchers?.length ?? 0) === 0 && (delta?.add?.operateTemplates?.length ?? 0) === 0;
        if (o.cleanup && !additive) throw new StepFailed("plan", "--cleanup needs a brief that only adds reports; this plan also changes other things (refine the brief or drop --cleanup)");
        const outcomes = await applyStep(s, o, budget, tid, build.id, messageId, delta, started, timings);
        summary.reports = outcomes;
      }
    }
    if (!o.dryRun) {
      const reports: ReportOutcome[] = summary.reports ?? [];
      const failed = reports.filter((r) => r.state === "failed" || r.state === "missing");
      const fb = reports.filter((r) => r.state === "fallback");
      if (failed.length) { state = `failed at report ${failed[0].name}: ${(failed[0].note ?? "did not land").slice(0, 200)}`; exit = 1; }
      else if (fb.length) { state = `built with fallback on ${fb.map((r) => r.name).join(", ")}`; exit = 2; }
      else { state = "built"; exit = 0; }
    }
  } catch (e: any) {
    state = e instanceof StepFailed ? `failed at ${e.stage}: ${e.reason}` : `failed at harness: ${e?.message ?? e}`;
    exit = 1;
    log(state);
  }

  // The built app, found by the id the build produced (a new build's app is renamed to it), and what the brief
  // asked for held against what was built: a What-if that was asked for and is not there is a FAILURE, never "built".
  if (!o.dryRun) {
    const buildId = createdBuildId ?? (summary.buildId as string | undefined);
    located = await locateApp(tid, buildId, o, !!createdBuildId, producedAppId, started).catch(() => located);
    if (located.error) { state = `failed: ${located.error}`; exit = 1; log(state); }
    const checkable = (o.newBuild || !!o.appSlug) && !located.error;
    if (checkable && hasDeliveryAsks(constraints) && !o.verifyOnly) {
      const delivery = await measureDelivery(tid, constraints, located.app?.id);
      deliveryBefore = delivery;
      summary.briefDelivery = { ...delivery, allowMissing: o.allowMissing };
      if (delivery.missing.length) log(`brief delivery: ${delivery.missing.join("; ")}`);
      if (!o.allowMissing && !state.startsWith("failed")) {
        if (delivery.critical) {
          const noWhatIf = constraints.requireWhatIf && !delivery.built.whatIf;
          state = noWhatIf ? "failed: what-if requested, none built" : `failed: tabs short: asked ${delivery.asked.tabs}, built ${delivery.built.tabs}`;
          exit = 1;
        } else if (delivery.missing.length && exit === 0) {
          state = `built with missing asks: ${delivery.missing.join("; ")}`;
          exit = 2;
        }
      }
    }
  }

  // Verify and repair: open the built app, fix what code can, send the rest back to Master Builder.
  if (o.verify && !o.dryRun && exit !== 1 && located.app) {
    try {
      // The app the build produced, by its real slug - which is not --app-slug when another app held that.
      const v = await verifyLoop(s, { ...o, appSlug: located.app.slug }, budget, tid, userId, createdBuildId ?? (summary.buildId as string | undefined), timings);
      summary.verify = v;
      // The repair loop edits and regenerates reports: an ask that was delivered before it and is gone after it
      // is damage, however clean the findings read.
      if (deliveryBefore) {
        const after = await measureDelivery(tid, constraints, located.app.id);
        // A chart or KPI the repair dropped and the guard put back is measured in `after` already: only what is still gone counts.
        const regressions = deliveryRegressions(deliveryBefore, after);
        summary.briefDeliveryAfterVerify = { ...after, regressions };
        if (regressions.length) { state = `verify removed delivered content: ${regressions.join("; ")}`; exit = 1; log(state); }
        else if (!o.allowMissing && after.missing.length && exit === 0) { state = `built with missing asks: ${after.missing.join("; ")}`; exit = 2; }
      }
      if (exit !== 1 && v.remainingBySeverity.error > 0) { state = `built, verify left ${v.remainingBySeverity.error} error(s)`; exit = 1; }
      else if (exit !== 1 && v.remainingBySeverity.warn > 0 && exit === 0) { state = `built, verify left ${v.remainingBySeverity.warn} warning(s)`; exit = 2; }
    } catch (e: any) {
      summary.verify = { error: e?.message ?? String(e) };
      log(`verify failed: ${e?.message ?? e}`);
    }
  }

  // Gate violations the model's reports carry, from the saved definitions.
  if (!o.dryRun && Array.isArray(summary.reports)) {
    const ids = summary.reports.map((r: any) => r.refId).filter(Boolean);
    const rows = ids.length ? await prisma.report.findMany({ where: { id: { in: ids }, tenantId: tid }, select: { id: true, name: true, definition: true } }).catch(() => []) : [];
    summary.gate = (rows as any[]).map((r) => ({ id: r.id, name: r.name, quality: safeParse(r.definition)?.quality ?? null }));
  }
  if (o.appSlug || located.app) {
    // Re-read: the verify loop may have changed the views since it was located.
    const app: any = located.app
      ? await (prisma as any).app.findFirst({ where: { id: located.app.id, tenantId: tid }, select: { title: true, slug: true, viewsJson: true } }).catch(() => null)
      : o.newBuild ? null // a new build's app is found by its id above; a slug here could name an older app
      : await (prisma as any).app.findFirst({ where: { tenantId: tid, slug: o.appSlug }, select: { title: true, slug: true, viewsJson: true } }).catch(() => null);
    const views = (safeParse(app?.viewsJson) ?? []) as any[];
    // How the What-if tab came to be: the build's notes say so when code (not the model) wrote it.
    const buildRow = summary.buildId ? await (prisma as any).masterBuild.findFirst({ where: { id: summary.buildId as string, tenantId: tid }, select: { statusJson: true } }).catch(() => null) : null;
    const notes: string[] = (safeParse(buildRow?.statusJson)?.notes ?? []) as string[];
    if (notes.length) summary.buildNotes = notes;
    const hasWhatIf = views.some((v) => v.kind === "whatif");
    summary.app = app
      ? {
        id: located.app?.id, name: app.title, slug: app.slug, requestedSlug: o.appSlug ?? null, actualSlug: app.slug,
        ...(located.slug.collision ? { slugCollision: { requested: located.slug.requested, actual: app.slug, heldBy: located.slug.collisionAppId ?? "another app" } } : {}),
        ...(located.renamedFrom ? { renamedFrom: located.renamedFrom } : {}),
        reportTabs: views.filter((v) => v.kind === "report").length, whatIfTab: hasWhatIf,
        whatIf: !hasWhatIf ? null : notes.some((n) => /what-if tab auto-generated/i.test(n)) ? "auto-generated" : notes.some((n) => /shorter prompt/i.test(n)) ? "designed (compact prompt)" : "designed",
      }
      : null;
  }

  // A dry run still wrote the brief and its proposal into the build's chat journal; take them back out
  // (a proposal left "proposed" would be offered to the next person who opens the build).
  if (o.dryRun && restore) {
    summary.dryRunJournal = (await (prisma as any).masterBuildMessage.deleteMany({ where: { buildId: restore.id, tenantId: tid, createdAt: { gte: started } } }).catch(() => ({ count: -1 }))).count;
  }

  // Cleanup.
  if (o.cleanup && !o.dryRun) {
    try { summary.cleanup = await cleanup(tid, started, restore, createdBuildId, s); } catch (e: any) { summary.cleanup = { error: e?.message }; }
  }

  summary.credit = await annotateSpend(tid, started, timings);
  const stats = await llmStats(tid, started);
  Object.assign(summary, {
    state, exitCode: exit, finishedAt: new Date().toISOString(), seconds: Math.round((Date.now() - started.getTime()) / 1000),
    fallbacks: (summary.reports ?? []).filter((r: any) => r.state === "fallback").map((r: any) => r.name),
    llm: stats,
  });
  return summary;
}

function safeParse(s: string | null | undefined): any { try { return s ? JSON.parse(s) : null; } catch { return null; } }

async function cleanup(tenantId: string, since: Date, restore: any, createdBuildId: string | null, s: Session) {
  const out: Record<string, number | string> = {};
  if (createdBuildId) {
    const r = await s.json(`/api/master-builder/${createdBuildId}`, { method: "DELETE" });
    out.deletedNewBuild = r.status;
    return out;
  }
  if (!restore) return out;
  const arts = await (prisma as any).masterBuildArtifact.findMany({ where: { buildId: restore.id, createdAt: { gte: since } } });
  let reports = 0;
  for (const a of arts) {
    if (a.kind === "report" && a.refId) reports += (await prisma.report.deleteMany({ where: { id: a.refId, tenantId } })).count;
  }
  out.reportsDeleted = reports;
  out.artifactsDeleted = (await (prisma as any).masterBuildArtifact.deleteMany({ where: { buildId: restore.id, createdAt: { gte: since } } })).count;
  out.messagesDeleted = (await (prisma as any).masterBuildMessage.deleteMany({ where: { buildId: restore.id, createdAt: { gte: since } } })).count;
  await (prisma as any).masterBuild.update({
    where: { id: restore.id },
    data: { version: restore.version, status: restore.status, planJson: restore.planJson, statusJson: restore.statusJson, lastIteratedAt: restore.lastIteratedAt, summary: restore.summary },
  });
  out.buildRestored = "yes";
  return out;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const url = new URL(o.base);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("mb-build.ts signs in with the seeded dev admin and only runs against a local server");
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "localhost")) throw new Error("DATABASE_URL is not local — refusing");
  const brief = o.verifyOnly ? "" : fs.readFileSync(o.briefFile, "utf8").trim();
  if (!o.verifyOnly && !brief) throw new Error("the brief file is empty");
  const { make } = await openSession(o.base);
  const tenant = await prisma.tenant.findUnique({ where: { slug: o.slug }, select: { id: true } });
  if (!tenant) throw new Error(`no workspace "${o.slug}"`);

  let results: Summary[];
  if (o.bench > 0) {
    results = [];
    log(`bench: ${o.bench} dry run(s), ${o.concurrency} at a time`);
    for (let i = 0; i < o.bench; i += o.concurrency) {
      const batch = await Promise.all(Array.from({ length: Math.min(o.concurrency, o.bench - i) }, () => oneRun({ ...o, dryRun: true }, brief, make, tenant.id)));
      results.push(...batch);
    }
    const secs = results.map((r) => r.seconds as number);
    const summary = {
      bench: { runs: results.length, concurrency: o.concurrency, success: results.filter((r) => r.exitCode === 0).length, p50s: pct(secs, 0.5), p95s: pct(secs, 0.95), maxS: Math.max(...secs), seconds: secs, states: results.map((r) => r.state) },
      runs: results,
    };
    emit(summary, o);
    process.exit(results.every((r) => r.exitCode === 0) ? 0 : 1);
  }
  const r = await oneRun(o, brief, make, tenant.id);
  emit(r, o);
  process.exit(r.exitCode);
}

function emit(summary: unknown, o: Opts) {
  const json = JSON.stringify(summary);
  if (o.out) fs.writeFileSync(o.out, JSON.stringify(summary, null, 2));
  console.log("MB_SUMMARY " + json);
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
