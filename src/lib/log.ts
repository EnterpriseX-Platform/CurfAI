/**
 * Structured logging — one JSON object per line on stdout, for the cluster's log shipper (Loki, see docs/OBSERVABILITY.md).
 *
 *   log.info("schedule fired", { scheduleId, ms })       // message first, then fields
 *   log.error("tick failed", { err })                     // `err` is an Error: type, message and a short stack are kept
 *
 * Every line carries the id of the request it was written under (`requestId`, also sent back to the caller as `x-request-id`)
 * and, once the person is known, `tenantId` and `userId` (opaque ids, never a name or an address). The request id is bound by the
 * HTTP observer (lib/observability/http.ts); a cron tick or job runs under `withLogContext`.
 *
 * What a log line may never hold is enforced here, not left to each caller, because the person writing the next log call will not
 * remember: a field whose NAME looks like a credential (password, token, secret, cookie, authorization, api key, `*Enc`) is
 * replaced, and anything that LOOKS like an email address is replaced wherever it appears (a field value, an error message).
 * Strings are cut at 500 characters, objects at four levels. A name or an address a person typed is personal data; log the id.
 *
 * Level: `CURF_LOG_LEVEL` (debug | info | warn | error | silent), default info. Tests run silent unless they pass a sink.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "debug" | "info" | "warn" | "error";
type Threshold = LogLevel | "silent";
const RANK: Record<Threshold, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export type LogContext = { requestId?: string; tenantId?: string; userId?: string; route?: string };
// On globalThis: Next compiles this module once for instrumentation.ts (which binds the request id) and again for the route
// handlers (which write the lines), and two stores would never see each other's context.
const shared = globalThis as { __curfLogContext?: AsyncLocalStorage<LogContext> };
const store = (shared.__curfLogContext ??= new AsyncLocalStorage<LogContext>());

/** Run `fn` with a log context: every line written inside it (however many awaits later) carries it. */
export function withLogContext<R>(ctx: LogContext, fn: () => R): R {
  return store.run({ ...ctx }, fn);
}
export function currentLogContext(): LogContext | undefined { return store.getStore(); }
export function currentRequestId(): string | undefined { return store.getStore()?.requestId; }
/** Add to the current context (the signed-in person is learned part way through a request). No context = nothing to add to. */
export function addLogContext(more: Pick<LogContext, "tenantId" | "userId">): void {
  const ctx = store.getStore();
  if (ctx) Object.assign(ctx, more);
}

const SECRET_KEY = /pass(word|wd)?|secret|token|authorization|cookie|api[-_]?key|credential|private[-_]?key|signature|(?:^|[a-z])Enc$|^otp$/i;
const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const MAX_STRING = 500;
const MAX_DEPTH = 4;
const MAX_ITEMS = 25;

function scrubString(s: string): string {
  const t = s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…` : s;
  return t.replace(EMAIL, "[email]");
}

function scrub(v: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (v == null || typeof v === "boolean" || typeof v === "number") return v;
  if (typeof v === "string") return scrubString(v);
  if (typeof v === "bigint") return v.toString();
  if (typeof v !== "object") return undefined; // functions, symbols
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Error) {
    // The stack carries file paths, not data; five frames are enough to find the line.
    const stack = typeof v.stack === "string" ? v.stack.split("\n").slice(0, 6).join("\n") : undefined;
    return { type: v.name, message: scrubString(v.message), ...(stack ? { stack: scrubString(stack) } : {}) };
  }
  if (seen.has(v)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[truncated]";
  seen.add(v);
  if (Array.isArray(v)) return v.slice(0, MAX_ITEMS).map((x) => scrub(x, depth + 1, seen));
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, val] of Object.entries(v)) {
    if (n++ >= MAX_ITEMS) { out["…"] = "[more fields]"; break; }
    out[k] = SECRET_KEY.test(k) ? "[redacted]" : scrub(val, depth + 1, seen);
  }
  return out;
}

export type LogSink = (line: string) => void;
type Fields = Record<string, unknown>;

export type Logger = Record<LogLevel, (msg: string, fields?: Fields) => void>;

export function createLogger(opts: { level?: Threshold; sink?: LogSink; now?: () => Date } = {}): Logger {
  const sink: LogSink = opts.sink ?? ((line) => { process.stdout.write(line + "\n"); });
  const now = opts.now ?? (() => new Date());
  const threshold = () => RANK[opts.level ?? levelFromEnv()];
  const write = (level: LogLevel, msg: string, fields?: Fields) => {
    if (RANK[level] < threshold()) return;
    const ctx = store.getStore();
    // Context and fixed keys come last so a caller's field can't overwrite the line's own level, time or request id.
    const line = {
      ...(scrub(fields) as Fields | undefined),
      ...(ctx ? scrub(ctx) as Fields : {}),
      level, time: now().toISOString(), msg: scrubString(String(msg)),
    };
    try { sink(JSON.stringify(line)); } catch { /* a log line must never break the work that wrote it */ }
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}

function levelFromEnv(): Threshold {
  const v = process.env.CURF_LOG_LEVEL?.trim().toLowerCase();
  if (v && v in RANK) return v as Threshold;
  return process.env.VITEST ? "silent" : "info";
}

export const log: Logger = createLogger();
