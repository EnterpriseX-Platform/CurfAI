/**
 * PDF renderer. Opens the report's internal viewer URL in headless Chromium
 * with ?print=1 and prints to PDF. This is why designer + viewer share the
 * same <ReportDocument>: what you see is exactly what's printed.
 */
import { withBrowserPage } from "@/lib/reporting/renderers/headlessBrowser";
import { openReportViewer } from "@/lib/reporting/renderers/reportViewerPage";
import type { RunViewer } from "@/lib/reporting/runner";

const PAGE_SIZE_MAP: Record<string, string> = {
  A4: "A4",
  Letter: "Letter",
  Legal: "Legal",
};

export type PdfOptions = {
  reportId: string;
  /**
   * Owner of the report. Required: the viewer page takes the tenant it
   * scopes by from the render token minted from this, so a caller that
   * cannot name the tenant has no business rendering the report. The cron
   * and any API-key caller have no user cookie to forward, and this is the
   * only identity they carry.
   */
  tenantId: string;
  /**
   * Who the PDF renders as: the caller (lib/reporting/exportCaller.ts
   * exportViewer()) or a delivery's creator (deliveryViewer()). Required
   * for the same reason as tenantId: an API key or the cron has no cookie,
   * and the page applies the data-source ACL and lake redaction for exactly
   * this identity.
   */
  viewer: RunViewer;
  /**
   * Show the role-gated blocks `viewer` may see: set by an on-demand export,
   * so an API key's PDF has the blocks its XLSX/DOCX/CSV have. A scheduled
   * delivery leaves it off, and its blocks filter as a viewer with no roles
   * whoever created it (see lib/reporting/exportCaller.ts). A forwarded
   * session decides blocks either way.
   */
  blocksAsViewer?: boolean;
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
  /** The requesting user's rd_era cookie (Thai years). A report's own dateEra still wins. */
  era?: "be" | "ce";
};

export async function renderPdf(opts: PdfOptions): Promise<Buffer> {
  return withBrowserPage("pdf", async (page) => {
    await openReportViewer(page, "PDF export", opts);
    // Allow Recharts to finish laying out.
    await page.evaluate(() => new Promise((r) => setTimeout(r, 200)));
    const pdf = await page.pdf({
      format: (PAGE_SIZE_MAP[opts.pageSize ?? "A4"] ?? "A4") as any,
      landscape: !!opts.landscape,
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
    return Buffer.from(pdf);
  });
}
