/**
 * Points a capture page at the report's own viewer, the same
 * <ReportDocument> the user sees, and returns once the report has
 * actually rendered and its charts have drawn. The PDF export and the xlsx
 * renderer's chart screenshots both go through here, so neither can capture
 * something the other would have refused.
 */
import type { Page } from "puppeteer";
import { internalBase } from "@/lib/http/appBase";
import { setSessionCookie } from "@/lib/reporting/renderers/puppeteerAuth";
import { mintRenderToken } from "@/lib/reporting/renderToken";
import type { RunViewer } from "@/lib/reporting/runner";

export type ReportViewerTarget = {
  reportId: string;
  /** Owner of the report. With `viewer`, proves to the page that this
   *  navigation is us, since `print=1` on its own used to be the whole
   *  credential (see lib/reporting/renderToken.ts). Without both, the page
   *  renders only for whoever the forwarded session cookie belongs to. */
  tenantId?: string | null;
  /** Who the report runs as when there is no session cookie: an API key,
   *  or a scheduled delivery's creator (see lib/reporting/exportCaller.ts). */
  viewer?: RunViewer | null;
  /** With no session cookie, show the blocks `viewer` may see: an on-demand
   *  export. Off, the page filters them as a viewer with no roles, which is
   *  what a scheduled delivery needs (see lib/reporting/renderToken.ts). */
  blocksAsViewer?: boolean;
  params: Record<string, unknown>;
  /** "name=value" of the caller's session cookie, forwarded so the viewer
   *  doesn't bounce to /login. */
  authCookie?: string | null;
  /** The requesting user's rd_locale cookie value (see lib/i18n/LocaleContext.tsx). */
  locale?: string;
  /** The requesting user's rd_era cookie — Buddhist-era or Gregorian Thai years. Unset: Buddhist era. */
  era?: "be" | "ce";
};

/** `what` names the capture in the error, e.g. "PDF export". */
export async function openReportViewer(page: Page, what: string, t: ReportViewerTarget): Promise<void> {
  const baseUrl = internalBase();
  const url = new URL(`/reports/${t.reportId}`, baseUrl);
  url.searchParams.set("print", "1");
  if (t.tenantId && t.viewer) {
    url.searchParams.set("rt", mintRenderToken({ tenantId: t.tenantId, reportId: t.reportId, viewer: t.viewer, blocksAsViewer: t.blocksAsViewer }));
  }
  for (const [k, v] of Object.entries(t.params ?? {})) {
    if (v != null) url.searchParams.set(`p.${k}`, String(v));
  }

  if (t.authCookie) await setSessionCookie(page, baseUrl, t.authCookie);
  if (t.locale) {
    await page.setCookie({
      name: "rd_locale",
      value: t.locale,
      domain: new URL(baseUrl).hostname,
      path: "/",
    });
  }
  if (t.era) {
    await page.setCookie({ name: "rd_era", value: t.era, domain: new URL(baseUrl).hostname, path: "/" });
  }
  await page.goto(url.toString(), { waitUntil: "networkidle0", timeout: 60_000 });
  await waitForRendered(page, ".report-doc", `${what}: report ${t.reportId}`);
}

/**
 * After page.goto(): wait until `root` actually rendered, its fonts loaded
 * and every chart inside it drew — throws otherwise. Used for a report
 * (".report-doc") and the app board pack (".pack-doc", executive journey P6).
 */
export async function waitForRendered(page: Page, root: string, what: string): Promise<void> {
  // Capture only a page that actually rendered. page.goto()
  // doesn't throw on a not-found page. And since (main)/loading.tsx streams
  // every page behind a Suspense boundary, a notFound() here answers 200
  // anyway, so the status can't be trusted. Without this check a missing or
  // unauthorised report came out as a capture of the "page could not be
  // found" screen, and went out on a schedule as if it were the report.
  // .report-doc is ReportDocument's root on every surface.
  const rendered = await page
    .waitForSelector(root, { timeout: 15_000 })
    .then(() => true, () => false);
  if (!rendered) {
    throw new Error(`${what} did not render (not found, not permitted, or failed to load)`);
  }
  // Webfonts are `display: swap`, so the first paint can be in the fallback
  // face. Neither page.pdf() nor a screenshot waits for fonts on its own.
  await page.evaluate(() => document.fonts.ready);
  // Recharts charts draw only on the client. A ResponsiveContainer renders
  // nothing until it has measured its box, which happens once the page has
  // hydrated. The server-rendered page already passes the root check
  // above with every chart container still empty: loading the viewer with
  // JavaScript off shows exactly that. networkidle0 only means the scripts
  // have arrived. On a busy pod hydration can still be running, and a
  // capture taken then shows each chart's card with nothing inside it.
  // Gauge, bullet, sunburst, sankey, box plot, radial, parallel, network and
  // chord are hand-drawn SVG sized by CSS and are already in
  // the server-rendered HTML, so they have nothing to wait for.
  const drawn = await page
    .waitForFunction(
      (sel: string) => Array.from(document.querySelectorAll(`${sel} .recharts-responsive-container`))
        .every((c) => c.childElementCount > 0),
      { timeout: 15_000 },
      root,
    )
    .then(() => true, () => false);
  if (!drawn) {
    throw new Error(`${what} rendered, but its charts never finished drawing`);
  }
}
