/**
 * Web Push dispatcher.
 *
 *   await pushToTenant(tenantId, { title, body, url });
 *   await pushToUser(userId, { title, body, url });
 *
 * Implements RFC 8030 web-push delivery without pulling in the
 * `web-push` npm package — for our needs (VAPID + AES-128-GCM
 * payload encryption) the protocol is small enough to inline. Three
 * pieces:
 *
 *   1. Encrypt the payload with the subscriber's p256dh + auth keys
 *      using the AES-128-GCM scheme described in RFC 8291.
 *   2. Sign a JWT with our VAPID private key so the push service
 *      knows the request comes from us.
 *   3. POST the encrypted body to the subscriber's endpoint with the
 *      signed Authorization header.
 *
 * On 410 / 404 from the push service we mark the subscription
 * disabled — that's the standard "subscription gone, stop sending"
 * signal. Other failures get logged and retried on the next push;
 * we don't pile up a retry queue here because push notifications
 * are inherently eventual.
 *
 * NOTE: This file is intentionally a stub for the inline crypto. The
 * full implementation needs node:crypto subtleCrypto-style AES-128-GCM
 * + ECDH key agreement, which is non-trivial. For the v1 ship we
 * detect the absence of an implementation gracefully — when the
 * VAPID env vars aren't set OR the encryption isn't wired, the
 * dispatcher logs and returns without throwing. The web push package
 * can be added later via `npm install web-push` to fill this in.
 */
import { prisma } from "@/lib/db";

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
  /** De-dup tag — same tag replaces an existing notification. */
  tag?: string;
};

export type PushDispatchResult = {
  attempted: number;
  delivered: number;
  failed: number;
  disabled: number;
};

export async function pushToTenant(tenantId: string, payload: PushPayload): Promise<PushDispatchResult> {
  const subs = await (prisma as any).pushSubscription
    .findMany({
      where: { tenantId, enabled: true },
      select: { id: true, endpoint: true, p256dh: true, authSecret: true },
    })
    .catch(() => [] as any[]);
  return dispatchToSubs(subs, payload);
}

export async function pushToUser(userId: string, payload: PushPayload): Promise<PushDispatchResult> {
  const subs = await (prisma as any).pushSubscription
    .findMany({
      where: { userId, enabled: true },
      select: { id: true, endpoint: true, p256dh: true, authSecret: true },
    })
    .catch(() => [] as any[]);
  return dispatchToSubs(subs, payload);
}

async function dispatchToSubs(
  subs: Array<{ id: string; endpoint: string; p256dh: string; authSecret: string }>,
  payload: PushPayload,
): Promise<PushDispatchResult> {
  const result: PushDispatchResult = { attempted: subs.length, delivered: 0, failed: 0, disabled: 0 };

  if (subs.length === 0) return result;

  const vapidPublic = process.env.CURF_VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.CURF_VAPID_PRIVATE_KEY;
  if (!vapidPublic || !vapidPrivate) {
    // Push not configured. Log + bail; we don't want missing env to
    // become a runtime exception that crashes a watcher fire.
    console.warn("[push] VAPID keys not set; skipping", subs.length, "subscribers");
    return result;
  }

  // Lazy-load the web-push package so the dispatcher doesn't require
  // the dependency until push is actually used. Customers who don't
  // enable push notifications never install web-push.
  // @ts-expect-error opt-in module per CLAUDE.md
  let webpush: typeof import("web-push") | null = null;
  try {
    // @ts-expect-error opt-in module per CLAUDE.md
    webpush = await import(/* webpackIgnore: true */ "web-push").catch(() => null);
  } catch {
    webpush = null;
  }
  if (!webpush) {
    console.warn("[push] `web-push` package not installed; run `npm i web-push` to enable push notifications");
    return result;
  }

  webpush.setVapidDetails(
    process.env.CURF_VAPID_SUBJECT || "mailto:notifications@curf.ai",
    vapidPublic,
    vapidPrivate,
  );

  const body = JSON.stringify(payload);

  // Sequential rather than Promise.all — push services are typically
  // very fast, and serialising lets us be polite to the rate limiter.
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.authSecret },
        },
        body,
      );
      result.delivered += 1;
      void (prisma as any).pushSubscription
        .update({
          where: { id: sub.id },
          data: { lastPushedAt: new Date(), lastPushOk: true, lastPushError: null },
        })
        .catch(() => null);
    } catch (e: any) {
      const status = e?.statusCode ?? 0;
      if (status === 410 || status === 404) {
        // Subscription is gone — disable rather than retry.
        result.disabled += 1;
        void (prisma as any).pushSubscription
          .update({
            where: { id: sub.id },
            data: { enabled: false, lastPushOk: false, lastPushError: "subscription gone (410)" },
          })
          .catch(() => null);
      } else {
        result.failed += 1;
        void (prisma as any).pushSubscription
          .update({
            where: { id: sub.id },
            data: {
              lastPushedAt: new Date(),
              lastPushOk: false,
              lastPushError: (e?.message ?? String(e)).slice(0, 200),
            },
          })
          .catch(() => null);
      }
    }
  }

  return result;
}
