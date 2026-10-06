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
 *   4. summary   per-stage timings, LLM calls (latency, tokens, retries,
 *                errors), fallbacks, report ids -> stdout as `MB_SUMMARY {json}`
 *
 * Final state, also the exit code:
 *   built                          0   everything asked for landed, no fallback
 *   built with fallback on <name>  2   (only with --allow-fallback) a Simplified report landed
 *   failed at <stage>: <reason>    1   gave up; what finished is kept
 *
 * Options:
 *   --build <id>          iterate this build (default: the workspace's newest ready build)
 *   --new-build           plan + build a brand-new build from the brief instead (plan job, resumed
 *                         from its last good stage on failure; then a background first-build apply)
 *   --app-slug <slug>     the app the brief is about; its pinned reports are listed in the summary
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
 * CURF_MB_REPORT_ATTEMPTS, CURF_MB_PLAN_BUDGET_MS.
 */
import fs from "node:fs";
import { prisma } from "../src/lib/db";

// ── args ─────────────────────────────────────────────────────────────

type Opts = {
  slug: string; briefFile: string; build?: string; newBuild: boolean; appSlug?: string;
  retries: number; budgetMs: number; allowFallback: boolean; cleanup: boolean; dryRun: boolean;
  bench: number; concurrency: number; base: string; out?: string;
};

function parseArgs(argv: string[]): Opts {
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--") && !["new-build", "allow-fallback", "cleanup", "dry-run"].includes(key)) { flags.set(key, next); i++; }
    else flags.set(key, true);
  }
  if (pos.length < 2) {
    console.error("usage: npx tsx scripts/mb-build.ts <workspaceSlug> <briefFile> [--build id] [--new-build] [--app-slug s] [--retries n] [--budget-min m] [--allow-fallback] [--cleanup] [--dry-run] [--bench n] [--concurrency c]");
    process.exit(64);
  }
  const num = (k: string, d: number) => (flags.has(k) ? Number(flags.get(k)) : d);
  return {
    slug: pos[0], briefFile: pos[1], build: flags.get("build") as string | undefined,
    newBuild: flags.has("new-build"), appSlug: flags.get("app-slug") as string | undefined,
    retries: num("retries", 3), budgetMs: num("budget-min", 30) * 60_000,
    allowFallback: flags.has("allow-fallback"), cleanup: flags.has("cleanup"),
    dryRun: flags.has("dry-run") || flags.has("bench"), bench: num("bench", 0), concurrency: Math.max(1, num("concurrency", 1)),
    base: (flags.get("base") as string) ?? "http://localhost:3100", out: flags.get("out") as string | undefined,
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

type Timing = { step: string; seconds: number; attempts: number; note?: string };
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
    const r = await s.post("/api/master-builder/iterate", { buildId, prompt: brief });
    const secs = (Date.now() - t) / 1000;
    if (r.status === 200 && r.body?.proposedMessageId) {
      timings.push({ step: "iterate", seconds: secs, attempts: attempt });
      return { messageId: r.body.proposedMessageId as string, delta: r.body.delta };
    }
    timings.push({ step: "iterate", seconds: secs, attempts: attempt, note: `HTTP ${r.status}: ${String(r.body?.error ?? "").slice(0, 160)}` });
    log(`iterate failed after ${secs.toFixed(0)}s: HTTP ${r.status} ${String(r.body?.error ?? "").slice(0, 200)}`);
    if (isFatal(String(r.body?.error ?? ""))) throw new StepFailed("iterate", String(r.body?.error ?? "").split("\n")[0]);
    if (r.status === 429) await sleep(20_000);
    else if (r.status >= 400 && r.status < 500 && r.status !== 502) throw new StepFailed("iterate", `HTTP ${r.status}: ${r.body?.error ?? "rejected"}`);
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
    const mine = arts.filter((a: any) => a.name === name);
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
    timings.push({ step: "apply", seconds: secs, attempts: attempt, note: `${state}; ${missing.length} report(s) outstanding` });
    if (state === "proposed") log("the apply threw and the proposal was handed back");
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
  summary.plan = { tables: plan.tables?.length, reports: (plan.reports ?? []).map((r: any) => r.name), app: plan.app?.name };
  return plan;
}

// ── main ─────────────────────────────────────────────────────────────

async function oneRun(o: Opts, brief: string, make: () => Session, tenantId: string): Promise<Summary> {
  const started = new Date();
  const budget = new Budget(Date.now() + o.budgetMs);
  const timings: Timing[] = [];
  const summary: Summary = { workspace: o.slug, mode: o.newBuild ? "new-build" : "chat-step", startedAt: started.toISOString(), timings };
  const s = make();
  const { tenantId: tid } = await s.login(o.slug);
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
    if (o.newBuild) {
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

  // Gate violations the model's reports carry, from the saved definitions.
  if (!o.dryRun && Array.isArray(summary.reports)) {
    const ids = summary.reports.map((r: any) => r.refId).filter(Boolean);
    const rows = ids.length ? await prisma.report.findMany({ where: { id: { in: ids }, tenantId: tid }, select: { id: true, name: true, definition: true } }).catch(() => []) : [];
    summary.gate = (rows as any[]).map((r) => ({ id: r.id, name: r.name, quality: safeParse(r.definition)?.quality ?? null }));
  }
  if (o.appSlug) {
    const app: any = await (prisma as any).app.findFirst({ where: { tenantId: tid, slug: o.appSlug }, select: { title: true, viewsJson: true } }).catch(() => null);
    summary.app = app ? { name: app.title, reportTabs: (safeParse(app.viewsJson) ?? []).filter((v: any) => v.kind === "report").length } : null;
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
  const brief = fs.readFileSync(o.briefFile, "utf8").trim();
  if (!brief) throw new Error("the brief file is empty");
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
