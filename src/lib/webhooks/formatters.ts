/**
 * Chat-platform payload formatters.
 *
 * The dispatcher posts the same Curf event JSON to every subscriber by
 * default. But three platforms — Slack, Microsoft Teams, Discord — only
 * render *their own* shapes nicely; raw JSON shows up as a wall of text
 * with no formatting.
 *
 * This module:
 *   1. Detects the right platform from the destination URL ("auto"), OR
 *      respects an explicit Webhook.payloadFormat ('slack' | 'teams' |
 *      'discord' | 'raw').
 *   2. Translates Curf's typed event into the platform's preferred shape
 *      (Slack Block Kit, Teams MessageCard, Discord embed).
 *
 * Adding a new formatter: implement formatFor<Platform>(event, data) and
 * register it in formatPayload().
 */
import type { WebhookEvent } from "./events";

export type PayloadFormat = "raw" | "auto" | "slack" | "teams" | "discord";

/** Detect the chat platform from the URL when format='auto'. */
export function detectFormat(url: string, explicit: PayloadFormat | string | null | undefined): "raw" | "slack" | "teams" | "discord" {
  if (explicit && explicit !== "auto") {
    if (explicit === "slack" || explicit === "teams" || explicit === "discord") return explicit;
    return "raw";
  }
  try {
    const host = new URL(url).host.toLowerCase();
    if (host === "hooks.slack.com" || host.endsWith(".slack.com")) return "slack";
    if (host.endsWith(".webhook.office.com") || host.endsWith(".logic.azure.com") || host.endsWith(".office.com")) return "teams";
    if (host === "discord.com" || host === "discordapp.com" || host.endsWith(".discord.com")) return "discord";
  } catch { /* malformed URL — fall through to raw */ }
  return "raw";
}

/**
 * Build the request body for one delivery. Returns the JSON string ready
 * to POST. The dispatcher signs the *raw* payload — we only ever change
 * the body shape, never the headers, so existing HMAC verification keeps
 * working unchanged.
 */
export function formatPayload(opts: {
  format: PayloadFormat | string;
  url: string;
  envelope: { id: string; event: string; createdAt: string; tenantId: string; data: any };
  // Optional event metadata so the formatter can show the human label.
  eventMeta?: WebhookEvent | null;
}): string {
  const { envelope, eventMeta } = opts;
  const fmt = detectFormat(opts.url, opts.format);
  if (fmt === "raw") return JSON.stringify(envelope);
  if (fmt === "slack") return JSON.stringify(toSlack(envelope, eventMeta));
  if (fmt === "teams") return JSON.stringify(toTeams(envelope, eventMeta));
  if (fmt === "discord") return JSON.stringify(toDiscord(envelope, eventMeta));
  return JSON.stringify(envelope);
}

// ============================================================================
// Per-event human formatting
// ============================================================================

/** Severity color (hex without #) for the platform's accent stripe. */
const SEVERITY: Record<string, { color: string; emoji: string; verb: string }> = {
  "watcher.fired":           { color: "C2410C", emoji: "🚨", verb: "Watcher fired" },
  "lake.backup.shipped":     { color: "16A34A", emoji: "📦", verb: "Backup shipped" },
  "lake.backup.failed":      { color: "DC2626", emoji: "❌", verb: "Backup failed" },
  "lake.mv.failed":          { color: "DC2626", emoji: "⚠️", verb: "MV refresh failed" },
  "comment.posted":          { color: "0EA5E9", emoji: "💬", verb: "Comment posted" },
  "publish.app.created":     { color: "8B5CF6", emoji: "🚀", verb: "App published" },
  "ai.usage.threshold":      { color: "EAB308", emoji: "💸", verb: "AI spend threshold crossed" },
  "report.created":          { color: "0EA5E9", emoji: "📊", verb: "Report created" },
  "report.updated":          { color: "94A3B8", emoji: "✏️", verb: "Report updated" },
  "report.deleted":          { color: "64748B", emoji: "🗑️", verb: "Report deleted" },
};

/** One-line human-readable summary per event. Used by all chat shapes. */
function summarize(event: string, data: any): string {
  switch (event) {
    case "watcher.fired":
      return `*${data.reportName ?? "(report)"}* — ${data.rowsFlagged ?? "?"} row${data.rowsFlagged === 1 ? "" : "s"} flagged at ${(data.thresholdPct ?? "?")}% threshold`;
    case "lake.backup.shipped":
      return `Snapshot shipped to *${data.destinationName ?? "(destination)"}* — ${formatBytes(data.bytesSent ?? 0)} in ${data.durationMs ?? 0}ms`;
    case "lake.backup.failed":
      return `Snapshot to *${data.destinationName ?? "(destination)"}* failed: ${truncate(data.error, 200)}`;
    case "lake.mv.failed":
      return `Materialized view *${data.mvName ?? data.mvId ?? "(mv)"}* failed: ${truncate(data.error, 200)}`;
    case "comment.posted":
      return `${data.authorName || data.author || "Someone"} on *${data.reportName ?? "(report)"}*: "${truncate(data.body, 140)}"`;
    case "publish.app.created":
      return `*${data.reportName ?? "(report)"}* published as <${data.url}|${data.slug}>`;
    case "ai.usage.threshold":
      return `Rolling 24h AI spend = $${(data.usdSpent ?? 0).toFixed?.(2) ?? data.usdSpent} — crossed $${(data.usdThreshold ?? 0).toFixed?.(2) ?? data.usdThreshold} threshold`;
    case "report.created":
      return `*${data.reportName ?? "(report)"}* created by ${data.createdBy ?? "?"}${data.via ? ` (via ${data.via})` : ""}`;
    case "report.updated":
      return `*${data.reportName ?? "(report)"}* updated to v${data.version ?? "?"} by ${data.updatedBy ?? "?"}`;
    case "report.deleted":
      return `Report deleted by ${data.deletedBy ?? "?"}`;
    default:
      // Unknown event — fall back to a stringified one-liner so the
      // recipient sees something useful instead of "[object Object]".
      return "```" + JSON.stringify(data).slice(0, 400) + "```";
  }
}

// ============================================================================
// Slack — Block Kit
// ============================================================================
// https://api.slack.com/block-kit
// Slack incoming-webhook URLs accept a payload with `text` (fallback) +
// `blocks` (rich formatting). The bot/app posting via OAuth supports the
// same shape, so this works for both flavours.

function toSlack(env: any, eventMeta?: WebhookEvent | null): any {
  const sev = SEVERITY[env.event] ?? { color: "64748B", emoji: "🔔", verb: env.event };
  const summary = summarize(env.event, env.data);
  const fallback = `${sev.emoji} ${sev.verb}: ${plainText(summary)}`;
  return {
    text: fallback,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${sev.emoji} *${sev.verb}*\n${summary}`,
        },
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `\`${env.event}\` · ${formatRelativeTime(env.createdAt)} · delivery \`${env.id.slice(0, 8)}\`` },
        ],
      },
    ],
  };
}

// ============================================================================
// Microsoft Teams — MessageCard (legacy connector format, still accepted)
// ============================================================================
// https://learn.microsoft.com/en-us/outlook/actionable-messages/message-card-reference
// Teams Incoming Webhook connector posts MessageCard. Newer Workflow
// connectors prefer Adaptive Cards but accept MessageCard too. We send
// MessageCard for max compatibility.

function toTeams(env: any, eventMeta?: WebhookEvent | null): any {
  const sev = SEVERITY[env.event] ?? { color: "64748B", emoji: "🔔", verb: env.event };
  const summary = summarize(env.event, env.data);
  return {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    themeColor: sev.color,
    summary: `${sev.verb}: ${plainText(summary).slice(0, 120)}`,
    title: `${sev.emoji} ${sev.verb}`,
    text: plainText(summary),
    sections: [
      {
        facts: [
          { name: "Event", value: env.event },
          { name: "When", value: env.createdAt },
          { name: "Delivery", value: env.id.slice(0, 8) },
        ],
      },
    ],
  };
}

// ============================================================================
// Discord — embeds
// ============================================================================
// https://discord.com/developers/docs/resources/webhook#execute-webhook
// Discord webhooks accept { content, embeds: [...] } where embeds get
// the colored side stripe + structured fields.

function toDiscord(env: any, eventMeta?: WebhookEvent | null): any {
  const sev = SEVERITY[env.event] ?? { color: "64748B", emoji: "🔔", verb: env.event };
  const summary = summarize(env.event, env.data);
  return {
    content: `${sev.emoji} **${sev.verb}**`,
    embeds: [
      {
        title: sev.verb,
        description: plainText(summary),
        color: parseInt(sev.color, 16), // Discord wants integer
        timestamp: env.createdAt,
        footer: { text: `${env.event} · ${env.id.slice(0, 8)}` },
      },
    ],
  };
}

// ============================================================================
// Helpers
// ============================================================================

function truncate(s: any, n: number): string {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
function formatBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}
function formatRelativeTime(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    const diff = Date.now() - t;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return Math.floor(diff / 60_000) + "m ago";
    if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + "h ago";
    return Math.floor(diff / 86_400_000) + "d ago";
  } catch { return iso; }
}
/** Strip Slack mrkdwn (asterisks, link syntax) for plaintext platforms. */
function plainText(s: string): string {
  return s
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2 ($1)");
}
