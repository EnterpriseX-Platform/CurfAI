/**
 * Outbound webhook dispatcher.
 *
 *   await emitWebhook({
 *     tenantId: "ten_abc",
 *     event: "watcher.fired",
 *     data: { watcherId, ... },
 *   });
 *
 * Looks up every enabled Webhook in the tenant whose `events` set
 * includes the event id, builds the payload, signs it with the per-row
 * signing secret, and POSTs. Each attempt becomes a WebhookDelivery row.
 *
 * Failure handling: 4xx responses are NOT retried (the customer's
 * endpoint rejected the payload — retrying won't help). 5xx + transport
 * errors get an exponential-backoff retry queue (1m → 5m → 30m, max 3
 * retries). The cron tick wakes up failed deliveries that are due.
 *
 * Fire-and-forget: emitWebhook() resolves once deliveries are queued,
 * not when remote endpoints respond. Production paths must never wait
 * on a slow customer endpoint.
 */
import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { knownEventIds, getEvent } from "./events";
import { formatPayload, type PayloadFormat } from "./formatters";
import { assertPublicHttpUrl } from "@/lib/security/ssrfGuard";

const PAYLOAD_CAP_BYTES = 4096;
const TRY_TIMEOUT_MS = 8000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000];

export type EmitOptions = {
  tenantId: string;
  /** Stable event id from EVENT_REGISTRY. */
  event: string;
  /** Domain payload — wrapped under `data` on the wire. */
  data: Record<string, unknown>;
};

export async function emitWebhook(opts: EmitOptions): Promise<void> {
  if (!knownEventIds().includes(opts.event)) {
    // Unknown event — refuse to emit so the dispatcher doesn't accumulate
    // typo'd ids that admins can never subscribe to. Logged so the dev
    // sees the misuse.
    console.warn(`[webhooks] unknown event id ignored: ${opts.event}`);
    return;
  }

  let subscribers: Array<{ id: string; url: string; signingSecret: string; events: string; payloadFormat: string }> = [];
  try {
    subscribers = await prisma.webhook.findMany({
      where: { tenantId: opts.tenantId, enabled: true },
      select: { id: true, url: true, signingSecret: true, events: true, payloadFormat: true },
    });
  } catch {
    // Webhook table missing pre-db-push — silently drop the emit so
    // emission-point code can deploy ahead of the migration.
    return;
  }
  // Filter in JS — the events column is a comma-separated string.
  const matched = subscribers.filter((w) => w.events.split(",").map((s) => s.trim()).includes(opts.event));
  if (matched.length === 0) return;

  // Build the envelope once; the formatter shapes it per-subscriber so
  // Slack/Teams/Discord URLs render natively while raw subscribers see
  // the canonical JSON. Each subscriber's body is signed independently
  // because the body bytes differ when the format does.
  const envelope = buildEnvelope(opts);
  const eventMeta = getEvent(opts.event);

  for (const w of matched) {
    const payloadJson = formatPayload({
      format: w.payloadFormat as PayloadFormat,
      url: w.url,
      envelope,
      eventMeta,
    });
    const cappedJson = payloadJson.length > PAYLOAD_CAP_BYTES ? payloadJson.slice(0, PAYLOAD_CAP_BYTES) : payloadJson;
    setImmediate(() => {
      void deliverOnce({
        tenantId: opts.tenantId,
        webhookId: w.id,
        url: w.url,
        signingSecret: w.signingSecret,
        event: opts.event,
        payloadJson,
        cappedJson,
        attempt: 0,
      }).catch(() => null);
    });
  }
}

type DeliveryWork = {
  tenantId: string;
  webhookId: string;
  url: string;
  signingSecret: string;
  event: string;
  payloadJson: string;
  cappedJson: string;
  attempt: number;
};

/**
 * Run one delivery. On 4xx we record + stop. On 5xx / transport we
 * record + (if attempts remain) schedule the next via setTimeout. On 2xx
 * we record success + update the Webhook's lastStatus.
 */
async function deliverOnce(work: DeliveryWork): Promise<void> {
  const t0 = Date.now();
  const timestamp = Math.floor(t0 / 1000).toString();
  const signature = sign(work.signingSecret, work.payloadJson, timestamp);

  let status: "ok" | "failed" = "failed";
  let responseCode: number | null = null;
  let responseBody: string | null = null;
  let errorMessage: string | null = null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRY_TIMEOUT_MS);
  try {
    // SSRF: this URL is tenant-supplied. assertPublicHttpUrl rather than
    // guardedFetch because redirect:"manual" here is deliberate — a 3xx is
    // treated as a failure, and guardedFetch would follow it instead.
    await assertPublicHttpUrl(work.url);
    const r = await fetch(work.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Curf-Webhooks/1.0",
        "x-curf-event": work.event,
        "x-curf-timestamp": timestamp,
        "x-curf-signature": signature,
        "x-curf-attempt": String(work.attempt),
        "x-curf-delivery-id": crypto.randomUUID(),
      },
      body: work.payloadJson,
      signal: ctrl.signal,
      redirect: "manual", // presigned URLs sometimes redirect-to-login on auth fail; treat that as a failure
    });
    responseCode = r.status;
    if (r.status >= 200 && r.status < 300) {
      status = "ok";
    } else {
      try { responseBody = (await r.text()).slice(0, 500); } catch { /* ignore */ }
      errorMessage = `HTTP ${r.status}`;
    }
  } catch (e: any) {
    errorMessage = (e?.message ?? String(e)).slice(0, 500);
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - t0;

  // Persist the audit row.
  await prisma.webhookDelivery.create({
    data: {
      tenantId: work.tenantId,
      webhookId: work.webhookId,
      event: work.event,
      payloadJson: work.cappedJson,
      status,
      responseCode,
      responseBody,
      errorMessage,
      durationMs,
      attempt: work.attempt,
    },
  }).catch(() => null);

  // Update the webhook's liveness summary so the admin list reflects
  // current state without joining the deliveries table on render.
  await prisma.webhook.update({
    where: { id: work.webhookId },
    data: { lastFiredAt: new Date(), lastStatus: status, lastError: errorMessage },
  }).catch(() => null);

  // Schedule a retry on transport / 5xx. 4xx and 2xx terminate.
  const retriable = status === "failed" && (responseCode == null || responseCode >= 500);
  if (retriable && work.attempt < RETRY_DELAYS_MS.length) {
    const delay = RETRY_DELAYS_MS[work.attempt];
    setTimeout(() => {
      void deliverOnce({ ...work, attempt: work.attempt + 1 }).catch(() => null);
    }, delay);
  }
}

/**
 * Stable envelope contract every recipient sees. Recipients should switch
 * on `event` and treat `data` as the typed body.
 */
type WebhookEnvelope = {
  id: string;
  event: string;
  createdAt: string;
  tenantId: string;
  data: unknown;
};

function buildEnvelope(opts: EmitOptions): WebhookEnvelope {
  return {
    id: crypto.randomUUID(),
    event: opts.event,
    createdAt: new Date().toISOString(),
    tenantId: opts.tenantId,
    data: opts.data,
  };
}

/** HMAC-SHA256(timestamp + "." + payload) hex. Same shape Stripe uses. */
function sign(secret: string, payload: string, timestamp: string): string {
  const msg = timestamp + "." + payload;
  return "sha256=" + crypto.createHmac("sha256", secret).update(msg).digest("hex");
}

/** Generate a fresh 32-byte hex secret for new webhooks / rotation. */
export function generateSigningSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Synchronous test delivery. Bypasses the queue + retry logic so the
 * admin "Test" button gets an immediate result. Records ONE
 * WebhookDelivery row tagged with attempt=-1 so it doesn't pollute
 * the retry attempt counter.
 */
export async function testDeliver(opts: {
  tenantId: string;
  webhookId: string;
  url: string;
  signingSecret: string;
  event: string;
  data: Record<string, unknown>;
  /** Optional payload format override; default 'auto' = detect from URL host. */
  payloadFormat?: PayloadFormat | string;
}): Promise<{ status: "ok" | "failed"; responseCode: number | null; durationMs: number; error?: string }> {
  const envelope = buildEnvelope({ tenantId: opts.tenantId, event: opts.event, data: opts.data });
  const payloadJson = formatPayload({
    format: opts.payloadFormat ?? "auto",
    url: opts.url,
    envelope,
    eventMeta: getEvent(opts.event),
  });
  const t0 = Date.now();
  const timestamp = Math.floor(t0 / 1000).toString();
  const signature = sign(opts.signingSecret, payloadJson, timestamp);

  let status: "ok" | "failed" = "failed";
  let responseCode: number | null = null;
  let errorMessage: string | undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRY_TIMEOUT_MS);
  try {
    // SSRF: same reasoning as deliverOnce above, and this one is worse —
    // testDeliver returns the status code to the caller, so an unguarded
    // URL here is a reflected probe rather than a blind one.
    await assertPublicHttpUrl(opts.url);
    const r = await fetch(opts.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Curf-Webhooks/1.0",
        "x-curf-event": opts.event,
        "x-curf-timestamp": timestamp,
        "x-curf-signature": signature,
        "x-curf-test": "1",
      },
      body: payloadJson,
      signal: ctrl.signal,
      redirect: "manual",
    });
    responseCode = r.status;
    if (r.status >= 200 && r.status < 300) status = "ok";
    else errorMessage = `HTTP ${r.status}`;
  } catch (e: any) {
    errorMessage = (e?.message ?? String(e)).slice(0, 500);
  } finally {
    clearTimeout(timer);
  }
  const durationMs = Date.now() - t0;

  await prisma.webhookDelivery.create({
    data: {
      tenantId: opts.tenantId,
      webhookId: opts.webhookId,
      event: opts.event,
      payloadJson: payloadJson.slice(0, PAYLOAD_CAP_BYTES),
      status,
      responseCode,
      errorMessage: errorMessage ?? null,
      durationMs,
      attempt: -1,
    },
  }).catch(() => null);

  await prisma.webhook.update({
    where: { id: opts.webhookId },
    data: { lastFiredAt: new Date(), lastStatus: status, lastError: errorMessage ?? null },
  }).catch(() => null);

  return { status, responseCode, durationMs, error: errorMessage };
}
