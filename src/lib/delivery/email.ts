/**
 * Email transport for Brief delivery (Stage 4.5b).
 *
 * Resend's HTTP API is the v1 transport — it's a single POST with a
 * Bearer token, no SMTP-port dance, no nodemailer dependency. If
 * RESEND_API_KEY isn't set we return a graceful "render-only" result so
 * the admin UI shows "Email channel pending transport setup" instead of
 * a hard failure. Adding SES, Postmark, or generic SMTP later just means
 * adding another branch in this file — the dispatcher's contract
 * (`sendEmail({to, subject, html, text})` returning `{ok, error?}`)
 * doesn't change.
 *
 * Required env to actually send:
 *   RESEND_API_KEY      = re_...
 *   BRIEF_EMAIL_FROM    = "Curf Brief <brief@your-domain.com>"
 *
 * The "from" address must be on a domain you've verified in Resend; this
 * is a deliverability requirement, not a Curf one.
 */

export type SendResult = { ok: boolean; error?: string };

export async function sendEmail(args: {
  to: string[];
  subject: string;
  html: string;
  text: string;
  /** Tenant whose Admin → Tenant SMTP settings act as the fallback transport. */
  tenantId?: string;
}): Promise<SendResult> {
  if (args.to.length === 0) {
    return { ok: false, error: "No recipients configured for this channel" };
  }

  const apiKey = process.env.RESEND_API_KEY ?? "";
  const from = process.env.BRIEF_EMAIL_FROM ?? "";
  if (!apiKey || !from) {
    // No Resend — fall back to the tenant/env SMTP transport so the one
    // Settings page (Admin → Tenant → Email) governs every email surface.
    return sendViaSmtp(args);
  }

  // Resend caps the recipient list at 50 per request; we'd never realistically
  // hit that with a Brief, but keep the cap explicit so a bad config doesn't
  // ratchet up costs silently.
  const recipients = args.to.slice(0, 50);

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: recipients,
        subject: args.subject,
        html: args.html,
        text: args.text,
      }),
    });
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 300);
      return { ok: false, error: "Resend " + res.status + ": " + errText };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: "Email transport threw: " + (e?.message ?? String(e)) };
  }
}

/** SMTP fallback — tenant settings (Admin → Tenant) first, SMTP_* env second. */
async function sendViaSmtp(args: {
  to: string[];
  subject: string;
  html: string;
  text: string;
  tenantId?: string;
}): Promise<SendResult> {
  const { resolveSmtp } = await import("@/lib/delivery/smtp");
  const smtp = await resolveSmtp(args.tenantId);
  if (!smtp) {
    return {
      ok: false,
      error: "Email transport not configured — set SMTP in Admin → Tenant → Email, or RESEND_API_KEY / SMTP_* env vars",
    };
  }
  let nodemailer: any;
  try {
    const dynImport: (s: string) => Promise<any> = new Function("s", "return import(s)") as any;
    const mod = await dynImport("nodemailer");
    nodemailer = mod.default ?? mod;
  } catch {
    return { ok: false, error: "nodemailer not installed — run `npm install nodemailer`" };
  }
  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user && smtp.pass ? { user: smtp.user, pass: smtp.pass } : undefined,
    });
    await transporter.sendMail({
      from: smtp.from,
      to: args.to.slice(0, 50).join(", "),
      subject: args.subject,
      html: args.html,
      text: args.text,
    });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: "SMTP send threw: " + (e?.message ?? String(e)) };
  }
}
