/**
 * The browser half of mb-verify: opens an app as the local dev admin, goes
 * through every tab in each language, measures what is on the page
 * (src/lib/master-builder/verify/probe.ts), checks that drill-downs and the
 * What-if answer when used, and returns Findings. Local development only.
 *
 * Dev-only: puppeteer is already a dependency (the PDF renderer), but
 * nothing in the app imports this.
 */
import path from "node:path";
import puppeteer from "puppeteer";
import { prisma } from "../../src/lib/db";
import { parseAppViews, type AppView } from "../../src/lib/apps/schema";
import { classifyPage, drilldownFinding, whatIfFinding, type ClassifyContext } from "../../src/lib/master-builder/verify/classify";
import { definitionPass } from "./definition";
import { clickTabJs, PROBE_JS, SETTLE_JS, TABS_JS, type ProbePage } from "../../src/lib/master-builder/verify/probe";
import { DEFAULT_ALLOWED_WORDS, rawCurrencyIn } from "../../src/lib/master-builder/verify/text";
import { countByKind, countBySeverity, type Finding, type FindingKind, type Locale } from "../../src/lib/master-builder/verify/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type VerifyOpts = {
  base: string;
  workspace: string;
  appSlug: string;
  /** Locales to open; the first is the structural pass (queries, charts, drill-down, What-if), the others check text. */
  locales: Locale[];
  /** Latin words that may stay in a Thai/Chinese page. */
  allowWords: string[];
  /** Limit to these tab labels (any locale's). */
  onlyTabs?: string[];
  drill: boolean;
  whatIf: boolean;
  /** Hover a mark of every chart/heatmap/map and read its tooltip. */
  hover?: boolean;
  /** Also read the saved definitions and their results (no browser): targets with no plan, reversed series, scope drift, decimals, ... Default on. */
  defs?: boolean;
  /** A folder to save a full-page screenshot of every tab view in. */
  shots?: string;
  log?: (...a: unknown[]) => void;
};

export type VerifyResult = {
  workspace: string;
  app: string;
  seconds: number;
  tabViews: number;
  findings: Finding[];
  byKind: Record<string, number>;
  bySeverity: Record<string, number>;
  /** Report names by id, for the repair brief. */
  reportNames: Record<string, string>;
};

/** What the other locales are held to: words and fit (a Thai table wraps taller), not data (the first locale already covered those). */
const TEXT_KINDS = new Set<FindingKind>(["text-clipped", "untranslated", "wrong-language", "raw-column-name", "kpi-raw-currency", "raw-currency", "label-offframe", "label-overlap", "table-overflow", "card-scrolls", "card-gap"]);

export function assertLocal(base: string) {
  const url = new URL(base);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("mb-verify signs in with the seeded dev admin and only runs against a local server");
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "localhost")) throw new Error("DATABASE_URL is not local — refusing");
}

export async function verifyApp(o: VerifyOpts): Promise<VerifyResult> {
  assertLocal(o.base);
  const log = o.log ?? (() => {});
  const t0 = Date.now();
  const tenant = await prisma.tenant.findUnique({ where: { slug: o.workspace }, select: { id: true } });
  if (!tenant) throw new Error(`no workspace "${o.workspace}"`);
  const app: any = await (prisma as any).app.findFirst({ where: { tenantId: tenant.id, slug: o.appSlug }, select: { id: true, viewsJson: true, title: true } });
  if (!app) throw new Error(`no app "${o.appSlug}" in workspace "${o.workspace}"`);
  const views = parseAppViews(app.viewsJson);
  const reportIds = [...new Set(views.map((v) => v.reportId).filter((x): x is string => !!x))];
  const reports = await prisma.report.findMany({ where: { id: { in: reportIds }, tenantId: tenant.id }, select: { id: true, name: true, definition: true } });
  const defs = new Map(reports.map((r) => [r.id, safeParse(r.definition)]));
  const reportNames = Object.fromEntries(reports.map((r) => [r.id, r.name]));

  const browser = await puppeteer.launch({ headless: true, args: ["--use-gl=angle", "--enable-webgl", "--ignore-gpu-blocklist"] });
  const findings: Finding[] = [];
  let tabViews = 0;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    // The first-visit tours (curf-tour-v1, curf-app-tour-<id>) float over the tabs; a verify run has seen them.
    // tsx compiles with keepNames: named helpers inside a page.evaluate function call __name, which the page does not have.
    await page.evaluateOnNewDocument(() => { (window as any).__name = (f: unknown) => f; });
    await page.evaluateOnNewDocument(() => {
      const get = Storage.prototype.getItem;
      Storage.prototype.getItem = function (k: string) { return /^curf-(app-)?tour/.test(k) ? "1" : get.call(this, k); };
    });
    let pageErrors: string[] = [], consoleErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 220)));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const t = m.text();
      if (/favicon|React DevTools|\[HMR\]|webpack-hmr|status of 404|Failed to load resource: net::ERR/.test(t)) return;
      consoleErrors.push(t.slice(0, 220));
    });
    await login(page, o.base, o.workspace);

    for (const [li, locale] of o.locales.entries()) {
      await page.setCookie({ name: "rd_locale", value: locale, url: o.base });
      const strip = await openApp(page, o.base, o.appSlug, log);
      // An app with one view has no tab strip (the tab lists on the page are the side panel's): the page is the one tab.
      const single = views.length <= 1;
      const labels = single ? [views[0] ? (views[0].labelI18n?.[locale] ?? views[0].label) : app.title ?? o.appSlug] : strip;
      log(`${locale}: ${labels.length} tabs`);
      for (let ti = 0; ti < labels.length; ti++) {
        const label = labels[ti]!;
        const view = matchView(views, labels, label, ti, locale);
        if (o.onlyTabs?.length && !o.onlyTabs.some((t) => t === label || t === view?.label)) continue;
        pageErrors = []; consoleErrors = [];
        if (!single && !(await page.evaluate(clickTabJs(label)))) {
          findings.push({ severity: "error", kind: "tab-missing", reportId: view?.reportId, tab: label, locale, detail: "the tab could not be found to open", suggestedFix: { action: "none", text: "check the app's views", autofix: false } });
          continue;
        }
        await settle(page);
        // Measured three times, a moment apart: only what every read shows counts. A machine under load paints late (fonts, layout), and a
        // finding that comes and goes is not one a reader can be sent to fix.
        await page.evaluate(() => document.fonts.ready.then(() => true));
        const first = (await page.evaluate(PROBE_JS)) as ProbePage;
        await sleep(1500);
        const second = (await page.evaluate(PROBE_JS)) as ProbePage;
        // A third read after the entrance animations of lower cards (staggered, slower under load) have run: a footer still sliding in reads as clipped.
        await sleep(2000);
        const probe = (await page.evaluate(PROBE_JS)) as ProbePage;
        tabViews++;
        const ctx: ClassifyContext = {
          tab: label, locale, reportId: view?.reportId, viewLabel: view?.label, allowWords: o.allowWords, expectBlocks: view?.kind === "report",
          pageErrors: [...new Set(pageErrors)], consoleErrors: [...new Set(consoleErrors)].slice(0, 3),
        };
        const secondKeys = new Set(classifyPage(second, ctx).map(stableKey));
        const firstKeys = new Set(classifyPage(first, ctx).map(stableKey).filter((k) => secondKeys.has(k)));
        const found = classifyPage(probe, ctx).filter((f) => (li === 0 || TEXT_KINDS.has(f.kind)) && firstKeys.has(stableKey(f))).map((f) => {
          // Category labels that leave a vertical bar chart: the bars can lie down (the saved definition says whether it is one).
          const own = f.kind === "label-offframe" && view?.reportId ? ((defs.get(view.reportId)?.pages ?? []).flatMap((p: any) => p.blocks ?? []) as any[]).find((b) => b.id === f.blockId) : undefined;
          return own?.type === "chart" && own.config?.chartType === "bar" && own.config?.orientation !== "horizontal"
            ? { ...f, suggestedFix: { action: "horizontal-bars" as const, autofix: true, text: "lay the bars down (orientation \"horizontal\"): the category names then run along the side, inside the card" } } : f;
        });
        findings.push(...found);
        if (o.shots) await page.screenshot({ path: path.join(o.shots, `${o.appSlug}-${locale}-${ti + 1}.png`), fullPage: true }).catch(() => {});
        log(`  ${locale} "${label}": ${probe.blocks.length} blocks, ${found.length} finding(s)`);

        if (o.hover && view?.kind === "report") findings.push(...(await hoverChecks(page, ctx, probe, view.reportId ? defs.get(view.reportId) : undefined)));
        if (li === 0 && o.drill && view?.kind === "report" && view.reportId) {
          findings.push(...(await drillChecks(page, ctx, probe, defs.get(view.reportId))));
        }
        if (li === 0 && o.whatIf && view?.kind === "whatif") {
          const f = await whatIfCheck(page, ctx);
          if (f) findings.push(f);
        }
      }
    }
  } finally {
    await browser.close();
  }
  if (o.defs !== false) findings.push(...(await definitionPass({ tenantId: tenant.id, views, reports, log })));

  const unique = new Map<string, Finding>();
  for (const f of findings) unique.set([f.kind, f.reportId, f.blockId, f.tab, f.locale, f.detail].join("|"), f);
  // A table is sized for the language that needs the most room; blank card in another language is that, not a defect — unless the first language has it too.
  const gapsInFirst = new Set(findings.filter((f) => f.kind === "card-gap" && f.locale === o.locales[0]).map((f) => `${f.reportId}|${f.blockId}`));
  const list = [...unique.values()].map((f) => f.kind === "card-gap" && f.locale !== o.locales[0] && !gapsInFirst.has(`${f.reportId}|${f.blockId}`)
    ? { ...f, severity: "info" as const, detail: `${f.detail} (the card is sized for the language that wraps the most)` } : f);
  return { workspace: o.workspace, app: o.appSlug, seconds: Math.round((Date.now() - t0) / 1000), tabViews, findings: list, byKind: countByKind(list), bySeverity: countBySeverity(list), reportNames };
}

const stableKey = (f: Finding) => [f.kind, f.blockId ?? "", f.locale, f.tab, f.suggestedFix.params?.text ?? ""].join("|");

function safeParse(s: string | null | undefined): any { try { return s ? JSON.parse(s) : null; } catch { return null; } }

/** A tab strip entry's view: by its label in this language, else by position when the strip and the views agree in length. */
function matchView(views: AppView[], labels: string[], label: string, index: number, locale: Locale): AppView | undefined {
  const byLabel = views.find((v) => (v.labelI18n?.[locale] ?? v.label) === label || v.label === label);
  if (byLabel) return byLabel;
  return labels.length === views.length ? views[index] : undefined;
}

export async function login(page: any, base: string, workspace: string) {
  const email = process.env.MB_EMAIL ?? "admin@curf.local";
  const password = process.env.MB_PASSWORD ?? "admin123";
  await page.goto(base + "/api/auth/csrf");
  const ok = await page.evaluate(async (email: string, password: string, slug: string) => {
    const { csrfToken } = await fetch("/api/auth/csrf").then((r) => r.json());
    await fetch("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken, email, password, json: "true" }) });
    const s = await fetch("/api/auth/session").then((r) => r.json());
    const m = (s?.user?.memberships ?? []).find((x: any) => x.tenantSlug === slug);
    if (!s?.user) return "sign-in failed (seed the database: npm run db:seed)";
    if (!m) return `the dev admin has no membership in workspace "${slug}"`;
    const c2 = await fetch("/api/auth/csrf").then((r) => r.json());
    await fetch("/api/auth/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ csrfToken: c2.csrfToken, data: { activeTenantId: m.tenantId } }) });
    const after = await fetch("/api/auth/session").then((r) => r.json());
    return after?.user?.tenantId === m.tenantId ? "ok" : "could not switch to the workspace";
  }, email, password, workspace);
  if (ok !== "ok") throw new Error(ok);
}

export async function openApp(page: any, base: string, appSlug: string, log: (...a: unknown[]) => void): Promise<string[]> {
  let resp: any = null;
  for (let tries = 0; tries < 3 && !resp; tries++) {
    try { resp = await page.goto(`${base}/apps/${appSlug}`, { waitUntil: "networkidle2", timeout: 240_000 }); }
    catch (e) { log(`retrying the app page: ${String(e).slice(0, 80)}`); }
  }
  if (!resp || resp.status() >= 400) throw new Error(`the app page answered ${resp?.status() ?? "nothing"}`);
  let tabs: string[] = [];
  for (let tries = 0; tries < 12 && tabs.length === 0; tries++) { await sleep(2500); tabs = (await page.evaluate(TABS_JS)) as string[]; }
  await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => /Skip tour|ข้าม|跳过/.test(x.textContent ?? "")); b?.click(); });
  return tabs;
}

/** Wait for the network, then for the drawing to stop changing (animations, lazy charts): three equal reads in a row. */
export async function settle(page: any) {
  try { await page.waitForNetworkIdle({ idleTime: 1200, timeout: 90_000 }); } catch { /* keep going */ }
  let last = "", same = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(700);
    const now = (await page.evaluate(SETTLE_JS)) as string;
    same = now === last && now.endsWith("|0") ? same + 1 : 0;
    if (same >= 2) return;
    last = now;
  }
}

/** The screen point of what to click or hover on a block: its first table row, its biggest bar/slice/symbol, or a dot of its line. */
export async function markPoints(page: any, blockId: string, blockType: string): Promise<Array<[number, number]> | "notarget" | null> {
  return page.evaluate((id: string, type: string) => {
      const el = document.querySelector(`[role="tabpanel"][data-state="active"] [data-block-id="${id}"]`);
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      let target: Element | null | undefined = null;
      if (type === "table") {
        const tr = el.querySelector("tbody tr");
        target = tr?.querySelector("button,a,[role=button],[class*=cursor-pointer]") ?? tr?.querySelector("td");
      } else if (type === "kpi") {
        // A KPI with a drill-down draws its number as a button (KpiBlock: role=button, title "open the rows behind").
        target = el.querySelector("[role=button]");
      } else {
        // The drawing is the biggest svg of the card (the first is often an icon).
        const sr = [...el.querySelectorAll("svg")].map((v) => v.getBoundingClientRect()).sort((a, c) => c.width * c.height - a.width * a.height)[0];
        const area = (n: Element) => { const r = n.getBoundingClientRect(); return r.width * r.height; };
        const usable = (n: Element, min: number) => {
          const r = n.getBoundingClientRect();
          const fill = getComputedStyle(n).fill;
          return r.width >= min && r.height >= min && fill !== "none" && !/rgba?\(0, 0, 0, 0\)|rgb\(255, 255, 255\)/.test(fill)
            && !n.closest(".recharts-legend-wrapper, .recharts-cartesian-grid, .recharts-tooltip-wrapper, button, clipPath, defs, mask")
            && (!sr || r.width * r.height < 0.6 * sr.width * sr.height);
        };
        // Bars, slices and symbols are the click targets; a line chart is clicked on one of its dots (the click reads the x under the mouse).
        let marks: Element[] = [];
        for (const sel of [".recharts-bar-rectangle path", ".recharts-pie-sector path", ".recharts-scatter-symbol path, .recharts-symbols", ".recharts-line-dot, .recharts-area-dot, circle.recharts-dot"]) {
          marks = [...el.querySelectorAll(sel)].filter((n) => usable(n, 3));
          if (marks.length) break;
        }
        if (!marks.length) marks = [...el.querySelectorAll("svg path, svg rect, svg circle")].filter((n) => usable(n, 8));
        marks.sort((a, c) => area(c) - area(a));
        if (marks.length && marks[0]!.getAttribute("class")?.includes("dot")) marks = [marks[Math.floor(marks.length / 2)]!];
        // Up to three candidates: the biggest, the next, and one from the middle — the biggest can be a backdrop.
        const picks = [marks[0], marks[1], marks[Math.floor(marks.length / 2)]].filter((m, i, all): m is Element => !!m && all.indexOf(m) === i);
        if (!picks.length) return "notarget";
        const pts: Array<[number, number]> = [];
        for (const m of picks) { m.scrollIntoView({ block: "center" }); const r = m.getBoundingClientRect(); pts.push([r.x + r.width / 2, r.y + r.height / 2]); }
        return pts;
      }
      if (!target) return "notarget";
      target.scrollIntoView({ block: "center" });
      const r = target.getBoundingClientRect();
      return [[r.x + r.width / 2, r.y + r.height / 2]];
  }, blockId, blockType);
}

/** Click the first mark (or row, or a KPI's number) of every block whose config has a drilldown; the panel must open with rows. */
async function drillChecks(page: any, ctx: ClassifyContext, probe: ProbePage, def: any): Promise<Finding[]> {
  const out: Finding[] = [];
  const blocks: any[] = (def?.pages ?? []).flatMap((p: any) => p.blocks ?? []);
  for (const b of blocks) {
    if (!b.config?.drilldown || !["chart", "table", "heatmap", "map", "kpi"].includes(b.type)) continue;
    const seen = probe.blocks.find((x) => x.id === b.id);
    if (!seen || seen.notRun || seen.empty) continue;
    const pts = await markPoints(page, b.id, b.type);
    if (pts === null) continue;
    const info = { id: b.id, title: seen.title, type: b.type };
    if (pts === "notarget") { out.push(drilldownFinding(ctx, info, "could not find a mark or row to click on this block (not tested)", true)); continue; }
    // Each candidate gets a click and a few seconds for the panel; one that opens with rows passes the block.
    let rows = 0;
    for (const pt of [...pts, ...(pts.length === 1 ? pts : [])]) {
      if (rows > 0) break;
      await page.evaluate((id: string) => document.querySelector(`[role="tabpanel"][data-state="active"] [data-block-id="${id}"]`)?.scrollIntoView({ block: "center" }), b.id);
      await sleep(400);
      const now = await markPoints(page, b.id, b.type);
      const at = Array.isArray(now) ? now[pts.indexOf(pt)] ?? now[0]! : pt;
      await page.mouse.move(at[0], at[1]);
      await sleep(250);
      await page.mouse.click(at[0], at[1]);
      for (let i = 0; i < 12 && rows === 0; i++) {
        await sleep(500);
        rows = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('[role="dialog"], [data-drill-panel], aside')].map((x) => x.querySelectorAll("tbody tr").length)));
      }
      if (rows === 0) { await page.keyboard.press("Escape"); await sleep(400); }
    }
    if (process.env.MB_VERIFY_DEBUG) console.error(`[drill] ${b.type} "${seen.title.slice(0, 40)}": ${rows} row(s)`);
    if (rows === 0) out.push(drilldownFinding(ctx, info, `clicking ${pts.length > 1 ? pts.length + " different marks" : "its mark/row"} did not open a panel with rows`));
    await page.keyboard.press("Escape");
    await sleep(600);
  }
  return out;
}

/** Hover a mark of every chart, heatmap and map: the tooltip that opens must not print money whole. */
async function hoverChecks(page: any, ctx: ClassifyContext, probe: ProbePage, def?: any): Promise<Finding[]> {
  const configs = new Map<string, any>(((def?.pages ?? []).flatMap((p: any) => p.blocks ?? []) as any[]).map((b) => [b.id, b]));
  const out: Finding[] = [];
  for (const b of probe.blocks.filter((x) => ["chart", "heatmap", "map"].includes(x.type) && !x.notRun && !x.empty).slice(0, 12)) {
    const found = await markPoints(page, b.id, b.type);
    if (!found || found === "notarget") continue;
    const pt = found[0]!;
    const before: string[] = await page.evaluate(() => document.body.innerText.split(String.fromCharCode(10)));
    await page.mouse.move(pt[0] - 6, pt[1]);
    await page.mouse.move(pt[0], pt[1]);
    await sleep(600);
    const after: string[] = await page.evaluate(() => document.body.innerText.split(String.fromCharCode(10)));
    const seen = new Set(before);
    const shown = after.filter((l) => l.trim() && !seen.has(l)).join(" | ");
    const raw = rawCurrencyIn(shown);
    // A heatmap with format "currency" prints its tooltip's money whole; "compact" (2.9M) is the block's own option for short numbers.
    const own = configs.get(b.id);
    const fixable = own?.type === "heatmap" && own.config?.format === "currency";
    if (raw.length) out.push({ severity: "warn", kind: "raw-currency", reportId: ctx.reportId, blockId: b.id, tab: ctx.tab, locale: ctx.locale, blockTitle: b.title.slice(0, 80), blockType: b.type, detail: `its tooltip shows ${raw.slice(0, 2).join(", ")} in full`,
      suggestedFix: fixable
        ? { action: "compact-currency", autofix: true, params: { tooltip: true }, text: "set the heatmap's format to \"compact\": the tooltip then prints 2.9M, not 2,874,138.00" }
        : { action: "none", autofix: false, text: "none in the report: the block's tooltip formats money whole; compact it in the block renderer (format.ts: thaiMoney / formatMetricCompact)" } });
    await page.mouse.move(2, 2);
  }
  return out;
}

/** Move the first driver; the numbers on the tab must change. */
async function whatIfCheck(page: any, ctx: ClassifyContext): Promise<Finding | null> {
  const snap = () => page.evaluate(() => (document.querySelector('[role="tabpanel"][data-state="active"]')?.textContent ?? "").replace(/\s+/g, " "));
  const before = await snap();
  const moved = await page.evaluate(() => {
    const input = [...document.querySelectorAll('[role="tabpanel"][data-state="active"] input[type="number"]')][0] as HTMLInputElement | undefined;
    if (!input) return "no driver";
    const v = Number(input.value), min = Number(input.min), max = Number(input.max);
    const span = Number.isFinite(max - min) && max > min ? max - min : Math.max(Math.abs(v), 1);
    const next = v + span * 0.25 <= (Number.isFinite(max) ? max : Infinity) ? v + span * 0.25 : v - span * 0.25;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, String(next));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return `${v} -> ${next}`;
  });
  if (moved === "no driver") return whatIfFinding(ctx, "the What-if tab has no driver to move");
  await sleep(3000);
  const after = await snap();
  return before === after ? whatIfFinding(ctx, `moving the first driver (${moved}) changed nothing on the tab`) : null;
}

export { DEFAULT_ALLOWED_WORDS };
