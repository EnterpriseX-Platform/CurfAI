/**
 * Delivery dispatcher for scheduled reports.
 *
 * Call `dispatchDelivery(schedule, rendered)` after rendering a scheduled
 * report. The dispatcher reads `schedule.deliveryConfigJson` and sends the
 * rendered artefact (or a summary of it) to the configured destination.
 *
 * Destinations supported out of the box:
 *   - "webhook" : POST JSON summary to an arbitrary URL (for Zapier, n8n, etc.)
 *   - "slack"   : POST a summary message to a Slack Incoming Webhook URL
 *   - "email"   : Send via SMTP if SMTP_* env vars are set, otherwise log.
 *   - "log"     : Log only (dev / no-op).
 *
 * Return shape is uniform so the caller can write a consistent audit row.
 */

import { postJson } from "@/lib/http/postJson";
import { resolveSmtp } from "./smtp";

// nodemailer is imported lazily inside dispatchEmail so this module can build
// even when nodemailer is not installed. Email delivery is opt-in via
// tenant SMTP settings (Admin → Tenant) or SMTP_* env vars.

export type DeliveryKind = "webhook" | "slack" | "email" | "log";

export type DeliveryConfig = {
  kind: DeliveryKind;
  url?: string;              // generic webhook target
  slackWebhook?: string;     // incoming-webhook URL for Slack
  recipients?: string[];     // email addresses (also read from schedule.recipients)
  fromEmail?: string;        // SMTP From header (defaults to SMTP_FROM env)
  subject?: string;          // email subject template; {{name}} is substituted
};

export type Rendered = {
  /** The raw bytes of the export. */
  body: Buffer;
  /** Filename to present in an attachment or link (e.g. "sales-summary.pdf"). */
  filename: string;
  /** Mime content type. */
  contentType: string;
  /** Friendly report name for message summaries. */
  reportName: string;
  /** Report id for deeplinks. */
  reportId: string;
  /** Absolute origin of the deployment ("https://curf.example.com") or null. */
  origin?: string;
  /** Tenant whose SMTP settings govern email delivery (Admin → Tenant). */
  tenantId?: string;
};

export type DispatchResult = {
  status: "delivered" | "skipped" | "failed";
  destination: DeliveryKind;
  message: string;
};

/** Resolve the config that governs this delivery. Always returns a valid shape. */
export function parseDeliveryConfig(json: string | null | undefined, fallbackRecipients: string[] = []): DeliveryConfig {
  // A schedule with recipients but no explicit channel config means the
  // user typed emails into a field labelled "Recipients (comma-separated
  // emails)" — deliver by email. Defaulting that case to "log" made every
  // UI-created schedule silently not send anything.
  const defaultKind: DeliveryKind = fallbackRecipients.length > 0 ? "email" : "log";
  try {
    if (!json) return { kind: defaultKind, recipients: fallbackRecipients };
    const parsed = JSON.parse(json) as Partial<DeliveryConfig>;
    const kind: DeliveryKind = (["webhook", "slack", "email", "log"] as const).includes(parsed.kind as any)
      ? (parsed.kind as DeliveryKind)
      : defaultKind;
    return {
      kind,
      url: parsed.url,
      slackWebhook: parsed.slackWebhook,
      recipients: parsed.recipients && parsed.recipients.length ? parsed.recipients : fallbackRecipients,
      fromEmail: parsed.fromEmail,
      subject: parsed.subject,
    };
  } catch {
    return { kind: defaultKind, recipients: fallbackRecipients };
  }
}

export async function dispatchDelivery(config: DeliveryConfig, rendered: Rendered): Promise<DispatchResult> {
  switch (config.kind) {
    case "webhook": return dispatchWebhook(config, rendered);
    case "slack":   return dispatchSlack(config, rendered);
    case "email":   return dispatchEmail(config, rendered);
    case "log":
    default:        return { status: "delivered", destination: "log", message: `Would deliver "${rendered.filename}" (${rendered.body.length} bytes) - kind=log` };
  }
}

// -------------------------------------------------------------------------
// Implementations
// -------------------------------------------------------------------------

async function dispatchWebhook(cfg: DeliveryConfig, r: Rendered): Promise<DispatchResult> {
  if (!cfg.url) return { status: "skipped", destination: "webhook", message: "No webhook URL configured" };
  const payload = {
    reportId: r.reportId,
    reportName: r.reportName,
    filename: r.filename,
    contentType: r.contentType,
    sizeBytes: r.body.length,
    generatedAt: new Date().toISOString(),
    downloadUrl: r.origin ? `${r.origin}/api/reports/${r.reportId}/export/${r.filename.split(".").pop()}` : null,
  };
  const res = await postJson(cfg.url, payload, { headers: { "User-Agent": "Curf/1.0" } });
  if (!res.ok) {
    return { status: "failed", destination: "webhook", message: `Webhook POST failed: ${res.status ? `HTTP ${res.status}` : res.body}` };
  }
  return { status: "delivered", destination: "webhook", message: `Webhook POST OK (${res.status})` };
}

async function dispatchSlack(cfg: DeliveryConfig, r: Rendered): Promise<DispatchResult> {
  const url = cfg.slackWebhook ?? cfg.url;
  if (!url) return { status: "skipped", destination: "slack", message: "No Slack webhook configured" };
  // Slack Incoming Webhooks don't accept file uploads - we send a summary
  // message with a deeplink. Real file delivery needs a Slack app with
  // files.upload scope; that's a followup.
  const deeplink = r.origin ? `${r.origin}/reports/${r.reportId}` : r.reportName;
  const text = `*${r.reportName}* is ready (${r.filename}, ${humanBytes(r.body.length)}).\n<${deeplink}|Open in Curf>`;
  const res = await postJson(url, { text });
  if (!res.ok) {
    return { status: "failed", destination: "slack", message: `Slack POST failed: ${res.status ? `HTTP ${res.status}` : res.body}` };
  }
  return { status: "delivered", destination: "slack", message: "Slack message posted" };
}

async function dispatchEmail(cfg: DeliveryConfig, r: Rendered): Promise<DispatchResult> {
  // Tenant-configured SMTP (Admin → Tenant) wins; SMTP_* env is the
  // platform fallback. See lib/delivery/smtp.ts.
  const smtp = await resolveSmtp(r.tenantId);
  if (!smtp) {
    return {
      status: "skipped",
      destination: "email",
      message: "SMTP not configured; skipped email delivery. Set it in Admin → Tenant → Email (SMTP), or via SMTP_* env vars.",
    };
  }
  const recipients = cfg.recipients ?? [];
  if (recipients.length === 0) {
    return { status: "skipped", destination: "email", message: "No recipients configured" };
  }

  let nodemailer: any;
  try {
    // Hide the specifier from webpack's static analyzer so the module is
    // only resolved at runtime - this keeps `next build` happy even when
    // nodemailer isn't installed.
    const modName = "nodemailer";
    const dynImport: (s: string) => Promise<any> = new Function("s", "return import(s)") as any;
    const mod = await dynImport(modName);
    nodemailer = mod.default ?? mod;
  } catch {
    return { status: "skipped", destination: "email", message: "nodemailer not installed - run `npm install nodemailer` to enable email delivery" };
  }
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user && smtp.pass ? { user: smtp.user, pass: smtp.pass } : undefined,
  });

  const subject = (cfg.subject ?? `${r.reportName} - Curf report`).replace(/\{\{name\}\}/g, r.reportName);

  try {
    const info = await transporter.sendMail({
      from: cfg.fromEmail ?? smtp.from,
      to: recipients.join(", "),
      subject,
      text: `Your scheduled Curf report "${r.reportName}" is attached. Generated ${new Date().toISOString()}.`,
      attachments: [{
        filename: r.filename,
        content: r.body,
        contentType: r.contentType,
      }],
    });
    return { status: "delivered", destination: "email", message: `Email sent: ${info.messageId ?? "ok"}` };
  } catch (e: any) {
    return { status: "failed", destination: "email", message: e?.message ?? "SMTP send threw" };
  }
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
