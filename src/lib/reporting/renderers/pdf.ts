/**
 * PDF renderer. Opens the report's internal viewer URL in headless Chromium
 * with ?print=1 and prints to PDF. This is why designer + viewer share the
 * same <ReportDocument>: what you see is exactly what's printed.
 */
import puppeteer from "puppeteer";

const PAGE_SIZE_MAP: Record<string, string> = {
  A4: "A4",
  Letter: "Letter",
  Legal: "Legal",
};

export type PdfOptions = {
  reportId: string;
  params: Record<string, unknown>;
  pageSize?: string;
  landscape?: boolean;
  authCookie?: string;
  reportName?: string;
  /** The requesting user's rd_locale cookie value (see lib/i18n/LocaleContext.tsx).
   *  Only the session cookie was ever forwarded to this Puppeteer page before,
   *  so a PDF always rendered in the server's default locale regardless of
   *  who asked for it — this closes that gap for report content carrying
   *  i18n overrides (see lib/reporting/localize.ts). */
  locale?: string;
};

export async function renderPdf(opts: PdfOptions): Promise<Buffer> {
  const baseUrl = process.env.INTERNAL_BASE_URL ?? "http://localhost:3100";
  const url = new URL(`/reports/${opts.reportId}`, baseUrl);
  url.searchParams.set("print", "1");
  for (const [k, v] of Object.entries(opts.params ?? {})) {
    if (v != null) url.searchParams.set(`p.${k}`, String(v));
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    if (opts.authCookie) {
      // Forward the caller's session so the viewer doesn't bounce to /login.
      const [name, value] = opts.authCookie.split("=", 2);
      if (name && value) {
        await page.setCookie({
          name,
          value: decodeURIComponent(value),
          domain: new URL(baseUrl).hostname,
          path: "/",
        });
      }
    }
    if (opts.locale) {
      await page.setCookie({
        name: "rd_locale",
        value: opts.locale,
        domain: new URL(baseUrl).hostname,
        path: "/",
      });
    }
    await page.goto(url.toString(), { waitUntil: "networkidle0", timeout: 60_000 });
    // Webfonts are `display: swap` — the first paint can be in the fallback
    // face, and page.pdf() has no font barrier of its own. Wait for them.
    await page.evaluate(() => document.fonts.ready);
    // Allow Recharts to finish laying out.
    await page.evaluate(() => new Promise((r) => setTimeout(r, 200)));
    const pdf = await page.pdf({
      format: (PAGE_SIZE_MAP[opts.pageSize ?? "A4"] ?? "A4") as any,
      landscape: !!opts.landscape,
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
