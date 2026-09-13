# Changelog

All notable changes to CurfAI. The in-app version (with Thai and Chinese translations) lives at `/admin/release-log`; this file mirrors it in English, generated from the same source — see `scripts/gen-changelog.ts`.

## [1.3.2] — 2026-09-12

Data-access hardening and Master Builder report fixes

**Fixed**
- Report Designer's upgrade-required message for premium theme presets now shows a clear explanation instead of a raw error.
- Fixed Master Builder's Recent Builds list showing stale data after using the browser's Back button to return from a finished build or its report — a just-created build could look missing even though it saved correctly.
- Fixed a Master Builder report gap where joining two tables whose relationship pointed from the detail table back to the summary table (e.g. approvals back to applications) produced a bare data table with no KPIs or chart, even though a valid relationship existed.

**Security**
- Fixed a gap where Notebook SQL cells could read table data a user's role isn't allowed to see, and skipped the same sensitive-column masking (PII, financial) enforced everywhere else. Notebook SQL now goes through the same access checks and redaction as every other data view.
- Fixed a gap in REST data connections where a request could be redirected to a different host than the one configured for the connection, while still carrying that connection's stored credentials. Requests now stay confined to the connection's own host.

## [1.3.1] — 2026-09-11

Landing page translations fully wired up

**Improved**
- Ask Curf now falls back to its rule-based answer engine on any AI provider failure — not just a missing API key — so a real outage (timeout, rate limit, 5xx) degrades to a working, clearly-labeled answer instead of showing a raw AI error message.
- When Master Builder can't design a custom plan because the AI provider is genuinely down, the error now offers one-click buttons to start from a working preset instead — all 8 (Sales, Marketing, Finance, Banking, Insurance, Retail, Energy, Manufacturing), not just three — no AI required, ready in about a second — rather than leaving you to retype a different prompt by hand.

**Fixed**
- The public landing page was showing stale or incomplete Thai and Chinese translations — most of the page (product pillars, use cases, the trust and autonomy layers, pricing, testimonials) rendered in English regardless of the selected language, and the Thai headline still showed the pre-rewrite tagline. The whole page is now fully translated and in sync with the current English copy.
- The "Every cell signed" badge on the hero preview hung slightly past the edge of its card in Thai (the translated text is longer than the English original) — it now sits flush inside the card in every language.
- The sign-in page ignored your chosen language entirely and always rendered in English, breaking the continuity of switching to Thai or Chinese on the homepage and clicking through to sign in. It now follows your selected language.
- Follow-up audit of today's other fixes: the Chinese landing/login page was missing ~130 translations (it silently fell back to English) and the Chinese homepage headline was still showing last month's tagline — both now fixed and verified. Also caught and fixed two smaller inconsistencies: one use-case card and one trust-layer example weren't translating, and a stale error hint that only mentioned 3 of the now-8 Master Builder presets.
- Opening "Create a workspace" from the workspace switcher left the switcher's own dropdown list open behind the new dialog instead of closing it, so the two overlapped on screen. Caught live in production — the dropdown now closes properly before the dialog appears.

## [1.3.0] — 2026-09-10

Analytic Apps get a major upgrade, plus 5 new industry starter packs

**New**
- The Analytic App view (the branded page you publish and share) got a major overhaul: every number now carries visible proof, tiles and charts drill through to filter the whole page, and approved actions are automatically tracked against the real result 30 days later — so you can see whether a decision actually worked.
- You can now ask a free-text question inside an Analytic App and get a brand-new view built on the spot — keep it as a permanent tab, or discard it, no engineering required.
- 5 new industry starter packs — Banking, Insurance, Retail, Energy, and Manufacturing — now show up as one-click cards on the Build page. Each one builds a complete working demo (tables, reports, and automated watchers) instantly, no AI setup needed.
- The search field in the top bar is now a real command palette. Press "/" anywhere to live-search your reports, tables, and saved views, or hand your whole question straight to Ask Curf.

**Improved**
- An approved Decision now shows its predicted impact on the metric it's tied to, not just whether it should go up or down.
- The Executive tab now proactively flags when a number was calculated from stale or shared data, with a direct link to fix it — instead of finding out the number was wrong after the fact.

**Fixed**
- One failed lookup could take down the entire Operate request list instead of just leaving out that one detail.
- The Account page was missing the sidebar and navigation that every other page has.

## [1.2.23] — 2026-09-09

Provenance design system — dark mode, charts, and mobile

**New**
- Curf now supports dark mode app-wide. Set Light, Dark, or Auto (follows your system) on the Account page — the whole app, including reports, charts, and every workspace and admin page, now has a matching dark theme.

**Improved**
- Reports, charts, tables, Operate, and the Knowledge Centre now share one consistent design system end to end: bar charts use flat, meaningful colors instead of decorative gradients; every admin and workspace page shares one page header; and one set of design tokens replaced hundreds of ad-hoc colors scattered across the app.

**Fixed**
- The sidebar could briefly show the wrong menu right after signing in, before flipping to the correct one a second or two later.
- Several admin and settings pages (Users & roles, API keys, Watchers, Schedules, Connections, and a report's Version history, among others) clipped their tables' action buttons on a narrow screen instead of letting you scroll to them.
- The report viewer's toolbar (Share, Export, Edit, and more) could run off the edge of the screen on a phone instead of wrapping onto its own row.

## [1.2.22] — 2026-09-08

Thailand map drill-through fixes

**Improved**
- The Map block now shows a warning when a report's data loaded successfully but none of it matched any region on the map (almost always a wrong "Region Field") — previously this rendered every region gray with no indication anything was misconfigured, identical to genuinely having no data yet.

**Fixed**
- Fixed the Thailand province map's floating detail card and district pins sometimes never appearing after clicking a province, even though the underlying data was correct — a container-size measurement could land mid-layout right after the click's navigation and get stuck at zero, silently blocking both features with no error. District pins are now also clickable themselves (zooming in on that district), since a hand-typed centroid doesn't always sit exactly on its own province's boundary underneath it.
- The map's Home/zoom-out button now actually clears the province filter along with the zoom — previously it reset the visual view but left every other province grayed out, with "Exit drill-down" still showing.

## [1.2.21] — 2026-09-07

Zero Dropout province map, dashboard fixes, and workspace polish

**New**
- The Dashboard Map block can now render a Thailand province-level choropleth (all 77 provinces), built for the Zero Dropout project to show per-province budget. Click a province to zoom in with a floating stat card, drag to pan around, or use the new +/-/home buttons to zoom manually; drilling into Pattani, Yala, or Narathiwat also surfaces real district-level pins and a province/district search box.

**Improved**
- Switching workspaces now shows a clean full-screen loading indicator instead of the screen looking frozen while the new workspace's Brief page loads.

**Fixed**
- Dashboards set to Custom Layout can now actually be created from scratch — the create form's "Custom Layout" template previously only worked when applied to an already-existing dashboard.
- Custom-layout dashboard cards no longer draw two nested borders and titles for Progress, Pivot, Heatmap, Map, Cohort Retention, and Funnel widgets, or for the existing Chart Only / Table + Chart templates — the same fix already shipped for charts now covers every widget type.
- The chart's floating actions menu (chart type, forecast, Ask/Comment/Embed) no longer overlaps the chart itself on the newly compact dashboard cards.
- Top KPIs no longer get silently cleared when saving a dashboard as Custom Layout, and a card resized very short in the layout editor no longer collapses its chart.
- Fixed clicking a province on the zoomed-in Thailand map sometimes doing nothing — ordinary mouse/trackpad click jitter was being misread as a drag-to-pan gesture and swallowing the click.

## [1.2.20] — 2026-09-04

Free-form dashboard layout

**New**
- Dashboards can now use a fully free-form layout — drag report cards anywhere and resize them, the same way blocks move on the Report Designer's canvas, instead of being locked into fixed grid/carousel templates. Pick "Custom Layout" when creating or editing a dashboard, then use the new "Edit Layout" button on the dashboard page itself to arrange cards; every dashboard card also picked up a theme-accent bar and a hover lift instead of a flat border.

**Fixed**
- Dashboard report cards were drawing two nested frames for the same content — the dashboard's own card border and title stacked on top of the chart's own border and title — wasting space and reading as cluttered. A chart now skips its own frame when it's the sole content of an already-carded dashboard cell.
- Reports created via "Auto-generate from table" carried a permanent "Auto-generated from your ... table. Edit any block to refine, or click Suggest..." caption meant as a note for whoever built the report — but it rendered identically for anyone who later viewed that report or dashboard. Removed; the Designer's own Suggest button already covers this.
- Editing a dashboard already set to Carousel, 1×2 Grid, or 2×2 Grid reopened the edit form with no template highlighted and the layout picker hidden, so saving without touching anything could silently reset its layout. Fixed.

## [1.2.19] — 2026-09-03

Menu Guide fixes

**New**
- Reports can now carry per-locale content overrides — a title, KPI label, or callout can have translated text for a specific language, and the viewer shows it automatically when that language is selected, falling back to the original text everywhere else. Wired into the main report viewer for now; the Designer, PDF export, and Dashboard embed still show the report's base language.
- When Master Builder's plan or chat-iterate step hits an AI error that a different sub-model might fix, an inline "switch sub-model and retry" control now appears — a dropdown populated from the tenant's own available models — instead of pointing you at Tenant Settings.

**Improved**
- Report content translations (added earlier this release) now also apply inside Dashboard views and PDF exports, not just the main report page.

**Fixed**
- The in-app Menu Guide (the "?" button in the top bar) was missing "On Screen" entirely, and its Metrics entry didn't mention the two most common ways to use one — wiring it into a report's KPI block, or logging a Decision against it. Both fixed.
- The Table Only, Table + Chart, and Chart Only dashboard layouts never applied a whole-page drill-down at all — the breadcrumb and top-KPI strip updated, but every chart and table on those layouts kept showing pre-drill data forever. Only the default layout was ever wired to the refetched data.
- A dashboard's top-KPI strip could throw "Missing parameter" the moment its KPIs referenced a drill dimension (e.g. "school") outside a fixed built-in list. It now binds whatever dimensions each KPI's own query actually references.
- A KPI headline number whose label reads as a year or code (e.g. "Latest Fiscal Year") was being compacted like a large count — 2568 displayed as "2.6K". Only genuine counts (students, budget line items) compact now.
- Switching workspaces used to just refresh whatever page you were already on — landing you on a report or admin screen scoped to the workspace you just left. It now takes you to Brief with fresh data, matching what creating a new workspace already did.
- A dashboard's "full report" view strips out table blocks (a table doesn't fit the wall-display style), but every block below it stayed at its original position — a blank gap exactly the size of the removed table. Blocks now shift up to fill the space.
- A funnel chart's on-segment value label was compacted like an axis tick (61,000 shown as "61K"); it now shows the real figure, since a label with room to spread out has none of the clipping risk that compacting exists for. Fixed separately: a Y-axis tick as long as "THB100K" lost its leading letter to a too-narrow axis gutter ("HB100K").

## [1.2.18] — 2026-08-31

A simpler dashboard picker, and more reliable AI model connections

**New**
- Ask Curf's example question chips (shown when you don't know what to ask) are now generated from this workspace's actual reports, governed metrics, and data tables instead of the same 3 generic examples every tenant saw. Pre-computed in the background and cached for 24h, so opening Ask Curf never waits on this.
- Clicking a chart to drill down now re-scopes the whole dashboard page at once — every card that understands the clicked dimension updates together, and the page breadcrumb grows to show the full drilled path (e.g. Dashboard / Budget / North), not just the one chart you clicked.

**Improved**
- Dashboard creation now offers 2 templates (Table + Chart, Chart Only) instead of 3 — Table Only dropped, since interactive dashboards never showed tables anyway. "On Screen" still offers all 3.
- Reasoning ("thinking") models that exhaust their token budget mid-thought and never answer now get a specific, actionable error instead of a vague "took too long or was blocked" message.
- Dashboard headline KPIs (Total Allocated Budget, etc.) now re-compute for the current drill-down scope instead of staying frozen at whole-tenant totals once you drill into a chart. Also fixed a multi-table KPI query that silently discarded every table after the first when combining a value split across several source tables.

**Fixed**
- "Test Connection" only sent a trivial plain-text ping, so a model could pass it and still fail under Master Builder, which always requests structured JSON. It now sends the same JSON-mode request Master Builder does.
- LLM calls to OpenAI-compatible providers (Kimi, DeepSeek, etc.) had no timeout — a slow provider could hang Master Builder indefinitely. Capped at 90 seconds with a clear error.
- The Custom (OpenAI-compatible) provider's blank-field default model, "kimi-k2", wasn't a real Moonshot model id — guaranteed 404 for any tenant relying on it. Now defaults to a verified working id.
- Newer Kimi models (e.g. kimi-k3) require temperature = 1 like the k2 line, but the code only recognized "kimi-k2" — kimi-k3 failed on every call. Broadened to the whole Kimi family.
- Raised the LLM request timeout from 55s to 90s — reasoning models have genuinely variable think time per request, and the tighter cap was cutting off calls that would have succeeded given a bit more room. Timeouts now also log server-side for diagnosis.
- Donut charts couldn't show data labels at all, and once enabled they printed raw unformatted numbers (e.g. "22906476639"). Both pie and donut slice labels now render through the same currency/number formatting as the rest of the chart.
- Drilling into a new region while a province from a previously-drilled region was still active produced a contradictory filter and a breadcrumb in click order instead of geographic order. Picking a broader level now clears any stale, incompatible level below it and the breadcrumb always reads region → province → district.
- Large dashboard headline numbers (e.g. a currency total in the billions) overflowed their card at full precision. They now render compact, matching the chart labels ($113.1B instead of $113,142,474,475.00).

## [1.2.17] — 2026-08-31

Interactive Dashboard hub, and two chart types that silently went blank

**New**
- The Dashboards page is now a grid/KPI hub — each dashboard a card with health, freshness, and a "needs review" flag — instead of a flat table. The full edit/kiosk-token screen is still one click away via "Manage all dashboards."
- Dashboards: charts and maps now support drill-down. Clicking a bar or region re-scopes the whole slot, with a breadcrumb to step back. Dashboards now show charts and KPIs only, never raw tables.
- Workspace admins can now permanently delete a workspace from Admin → Tenant → Danger zone, with slug confirmation and protection while a paid subscription is active.

**Improved**
- Switching workspaces while the URL still points at a report/dashboard from the tenant you left now redirects to the list instead of a bare "page not found."
- The forecast toggle no longer appears on charts that could never actually produce a forecast.

**Fixed**
- Pie and Treemap rendered completely empty when a data source returned numeric values as strings — Recharts summed them as text. Fixed to match Sunburst's existing handling.
- Interactive dashboards opened full-screen with no nav and a fixed height, squeezing some charts down to legend-only. Now embedded in the normal app layout, scrollable, showing every report at once. Also fixed a Top KPI showing 6700% instead of 67%.
- Chart forecasting, once enabled, silently applied to every chart including non-time-series ones, replacing real labels with meaningless "+1, +2, +3…" It now only activates on a real time axis.
- Large plain-number axis values could get clipped ("000,000" instead of "1,000,000"). Now compacts the same way currency already does (1.8B).
- The forecast fix above also broke forecasting on real time-series charts using Thai month labels ("ต.ค. 68") — now recognized correctly.

## [1.2.16] — 2026-08-28

Watcher plan enforcement, and a broken first-run experience fixed

**New**
- The chart type picker now shows all 16 supported types (was 5), grouped by purpose, with unusable types greyed out and explained. Master Builder and AutoCurf use the same check.
- Added Radar, Sunburst, and Sankey chart types.
- Added Streamgraph, a flowing variant of a stacked area chart.

**Improved**
- The empty Reports page no longer shows two duplicate "add report" buttons side by side.
- Sign-up now explains Individual vs. Organization account types before you choose, not after.

**Fixed**
- Tenants below the Growth plan could get unlimited Watchers via Master Builder, bypassing the quota the manual "Create watcher" button already enforced.
- Creating a Watcher on an unsupported plan failed silently. Now shows a clear error with an upgrade link.
- New workspaces' sample data connection failed for everyone ("unable to open database file") — the seed path didn't exist in the container. Now uses persistent storage.
- Fixed a crash when switching a Forecast-enabled chart to Combo.
- Fixed the forecast label overlapping plotted bars on some charts.
- Fixed forecasts occasionally projecting impossible negative values for metrics that never go negative.
- Fixed invisible Funnel chart labels when data isn't sorted largest to smallest.
- "Recommend Top KPIs" cards now show a plain-language description instead of the raw SQL query.

## [1.2.15] — 2026-08-27

Scoped API key allowlist enforcement across every report route

**New**
- Organizations. Sign-up now asks Individual or Organization — an Organization's Platform Admin can see and manage every workspace under it, even ones they haven't joined. Growth plan and above.
- New "On Screen" menu: a passive wall-display surface with report rotation, kiosk tokens, and all interactive controls hidden.

**Improved**
- Roles renamed: Editor → Developer (same permissions). Executive and Viewer can now see Watchers and Decisions read-only. Membership growth stays invite-only.
- The custom role/tag picker (Dashboard, Data Source, Table, Report visibility) now supports creating, deleting, and renaming tags in place, instead of a trip to Admin → Roles.

**Fixed**
- A Developer could lose edit access to a Lake Table they own — a leftover from the Editor → Developer rename.

**Security**
- Fixed: a report-scoped API key could bypass its allowlist through 18 tenant-only-filtered routes — including publishing out-of-scope reports and running arbitrary queries. All now enforce the allowlist.

## [1.2.14] — 2026-08-26

Supply-chain hardening and two fail-open security fixes

**New**
- Added real-time alerting for suspicious login activity: 5+ failed logins on the same account within 15 minutes now fires a webhook/Slack event to admins who've subscribed to it

**Improved**
- Documented a safe, tested procedure for rotating the tenant-secrets encryption key, built around an existing migration script that had never been wired into the runbook
- Suspicious-login alerts now also reach admins directly by email and show up as an item in the Operate Inbox, so every tenant is notified even without a webhook/Slack integration set up; also fixed a bug where an internal AI summary silently failed to save on every single Operate request
- One account per email, any number of workspaces: logging in and resetting your password now resolve deterministically instead of possibly hitting a different workspace's copy of your account, switching workspaces is instant (no more re-login), and removing someone from one workspace no longer risks deleting their account (and its data in every other workspace) — all live-migrated with zero downtime

**Fixed**
- Fixed Master Builder's custom-domain planner drifting into a random language for report/table descriptions, tour narration, and the build's own title in Recent Builds instead of matching the language of the request

**Security**
- Fixed a scoped API key falling back to full tenant access if its report allowlist ever failed to parse, and closed a path where a database hiccup could silently uncap the monthly AI-generate quota
- Hardened the CI/CD pipeline: least-privilege permissions on every GitHub Actions workflow, the Docker base image pinned to a verified digest instead of a floating tag, package signatures verified on every run, and a software bill of materials (SBOM) generated automatically
- Stopped an internal error (including a stack trace) from leaking into a Master Builder API response, and added a safety sweep so a build interrupted mid-run stops polling forever instead of getting stuck
- Fixed a session left over from a deleted account being able to keep working for weeks instead of losing access within minutes
- Added a check so an AI-written chart caption can no longer credit a category that doesn't actually appear in the chart's own data
- Closed a timing gap where firing several requests to create a report, dashboard, or watcher at the same moment could let a plan's limit be exceeded
- Hardened how a rolled-back Operate action rebuilds its form data against a crafted payload trying to hijack the object it's built on
- Closed a gap where a restricted API key could reach report sub-features (chat, comments, exports, forecasts, sharing, versions, and more) for reports outside its own allowlist, even though it was already blocked from the main report page
- Closed a gap where a data source or webhook URL that first passed our outbound-request safety check could redirect to an internal address and be followed anyway

## [1.2.13] — 2026-08-25

Public API contract test and component library fixes

**Improved**
- Added an automated check that keeps the public v1 API's documented endpoint catalog in sync with the real routes, and blocks any future v1 endpoint from being anything but read-only
- Synced the August roadmap into the automated roadmap-status checker — corrected several claimed dates and one claimed 'scheduled' status against what the code actually shows

**Fixed**
- Fixed the internal component library (Storybook) build, which had never actually succeeded — every block type now has a working visual reference, and a missing workspace-template setup endpoint was wired up in the process

**Security**
- Closed two public API endpoints (agent run, semantic search) that had no rate limit at all, and hardened the shared rate limiter's cleanup so it doesn't degrade under long-running traffic
- Added a Content-Security-Policy header and stopped announcing the framework in every response, closing out the last open items from an OWASP Top 10:2025 security review

## [1.2.12] — 2026-08-24

Observability metrics, navigation, and automated health-check fixes

**Improved**
- Added a real Prometheus metrics endpoint (the one referenced in internal docs previously didn't exist) so operators can scrape live request timing and LLM token usage, protected by a secret header

**Fixed**
- Fixed 4 bugs that were silently blocking the automated synthetic health-check (canary) from ever completing a full cycle, including one that would have let test data accumulate against a tenant's quota every 10 minutes
- Added tabs linking the Audit log, Usage, Lineage, and Actions pages — three of the four previously had no way to reach them from the sidebar at all, only by typing the URL directly

## [1.2.11] — 2026-08-23

Dependency security audit and automated roadmap status verification

**New**
- Added an automated roadmap status report — checks each roadmap claim against real signals in the code and flags any mismatch, with a PDF export for sharing
- Extended the forecast/prediction overlay to bar charts and KPI trend sparklines (previously line/area/combo only), with a shared visual style so a projection always reads as "predicted, not measured"
- Added a per-viewer forecast control — anyone can turn a chart's forecast on/off and pick the method (Linear, a new Smoothed/Exponential-Smoothing option, or AI) and horizon for themselves, no edit access required; the choice is remembered per user and fully translated (Thai/Chinese)
- Added a Forecast Accuracy trust layer — Curf now records every chart's forecast, grades it against the real value once it arrives, and shows a "Curf has been X% accurate" badge right in the forecast controls (Business tier)
- Dashboards are now interactive — tapping (or clicking) a chart opens the same drill-through panel reports already have, with auto-rotation pausing automatically so a kiosk/tablet display doesn't advance mid-read
- The forecast confidence band now spells out the best/worst case in plain text at the chart's edge ("Up to X (+Y%)" / "As low as X (-Y%)") instead of leaving it as a shaded region
- Added a "How is this range calculated?" explainer to the forecast popover — spells out the actual formula per method, plus why the 1.96 constant is used, for anyone who wants to see the math behind the confidence range

**Improved**
- Removed unused dependencies and updated docs-site packages to their latest secure versions

**Fixed**
- Fixed a Windows-specific bug that caused dev-only routes to be misreported as missing audit logging
- Fixed forecast projections landing on unrealistic dates on charts whose data isn't weekly (e.g. a monthly-snapshot chart was projecting 7 days at a time instead of about a month)
- Fixed the B2B SaaS template's "Active subscriptions by plan" table rendering with no columns at all
- Fixed a bug where every dashboard chart silently lost its "Ask Curf", comments, and embed buttons — a leftover expression was reading a report id from the wrong place
- Fixed forecast lines on charts using Thai-abbreviated month labels (e.g. "ต.ค. 68") showing "+1, +2, +3" instead of continuing with real months

**Security**
- Replaced the table formula engine to close two known vulnerabilities in how untrusted, user-authored formulas were sandboxed

## [1.2.10] — 2026-08-22

Documentation translation and PDF export, security hardening, and performance improvements

**New**
- Documentation is now split into a Getting Started guide and a Developer Document, both linked from the landing page
- Getting Started is now available in Thai and Chinese, with a new step-by-step tutorial for building a sample workspace
- Added a back-to-app link and a full-document PDF download to every docs page

**Improved**
- Fixed the query cache to actually speed up repeated report loads
- XLSX export is faster for large tables

**Fixed**
- AI-backed features now show a clear, translated message when the provider is rate-limited or misconfigured, instead of a raw provider error
- Fixed Marketplace incorrectly appearing signed-out when accessed from inside the app
- Materialized views on the Tables page now show the correct column count
- Fixed several stale documentation links
- Fixed two Developer Document sections missing from sidebar navigation

**Security**
- Closed a SQL guard gap that allowed write and DDL statements through MySQL and Postgres data sources
- Reports with write or DDL SQL in a data source are now rejected on save, not only when the query runs
- Closed an SSRF gap in REST data sources and webhook destinations
- Patched two next-auth vulnerabilities (CVE GHSA-7rqj-j65f-68wh, GHSA-xmf8-cvqr-rfgj)
- Master Builder now blocks generating synthetic data that duplicates an existing real table
- Rejected path-like table names on upload to prevent path traversal

## [1.2.9] — 2026-08-21

Full i18n rollout, read-only public API, and key platform fixes

**New**
- Every page, menu, and admin surface in the app is now fully translated across Thai, English, and Chinese — sidebar, Reports, Ask Curf, Notebooks, Dashboards, Brief, Master Builder, Metrics, Decisions, Operate (Inbox/Templates/Watchers/Insights/Action Center), Tables, Catalog, Connections, Data Quality, Schedules, Account, and nearly all of Admin
- New Admin → API Explorer page — browse the public API's endpoint catalog and fire real test requests at it right from the app, using your own session or a specific API key

**Improved**
- Added item-count badges to the Inbox, Watchers, and Data Quality sidebar items, matching the rest of the nav
- Release log entries are now grouped by category (New/Improved/Fixed/Security) instead of one flat list, and multiple same-day version bumps are consolidated into a single entry
- The Menu Guide now covers every item in the sidebar (including Ask Curf, Decisions, Metrics, Release log, and API Explorer) and always matches the current sidebar labels; signing out now returns you to the landing page instead of straight to the sign-in form

**Fixed**
- Fixed the language switcher not refreshing server-rendered page titles, subtitles, and breadcrumbs — switching locale now updates the whole page immediately instead of needing a manual reload
- Fixed Thai workspace/user slugs splitting mid-syllable — slug generation now correctly handles Thai combining vowel and tone marks
- Fixed Master Builder fabricating synthetic data instead of reusing a tenant's real uploaded tables when planning new tables or reports

**Security**
- The public API (/api/v1) is now read-only — third parties can fetch reports, dashboards, lake data, notebooks, and catalog entries, or run non-mutating queries (ask-chat, cell run, agent Q&A, semantic search), but can no longer create, update, or delete any Curf entity through the API

## [1.2.8] — 2026-08-19

AI governance fixes, mobile navigation & Ask Curf readability

**Improved**
- Finished unifying the two multi-step agent code paths into one implementation (`lib/agent/runLoop.ts`), keeping the better behavior of each rather than running two divergent agents side by side
- Causal driver output is now wired into Brief's narration, not just surfaced standalone

**Fixed**
- Fixed a hallucination-checker false positive on AI-generated percentages — the number regex used a trailing word-boundary that doesn't match right after a `%` sign, so correct percentage figures were being flagged as unverifiable
- Fixed the sidebar drawer on small screens — it sized to its content instead of the viewport, so nav items past Decisions (Tables, Metrics, Agent, Marketplace, Admin, ...) were unreachable and couldn't be scrolled to
- Fixed Ask Curf's workspace-wide answers rendering as one unreadable wall of text — the API already returned numbered "here's what's missing" answers with proper paragraph breaks, but the answer bubble had no whitespace CSS, so every line break was collapsed

**Security**
- Fixed PII scrubbing so it recurses into nested objects and arrays — REST data sources return rows in whatever shape the API gives them, and the redactor was previously only checking top-level string fields, so a credit card / Thai ID / SSN buried inside a nested object could slip through unmasked into the LLM prompt. Scope is unchanged: still CC / Thai ID / SSN only

## [1.2.6] — 2026-08-14

Predictive forecasting, decision outcomes, regional channels & security hardening

**New**
- Watchers can now warn before a threshold is crossed, not just after — a new predictive mode projects the current trend forward
- Every governed Metric forecasts its own next value, surfaced automatically in Ask Curf, Brief, and the Metrics page
- Brief now narrates forward ("on track to reach X by Y"), not just what already happened
- Decision Log rolls up win-rates by scenario, and surfaces a hint from similar past decisions before you commit to a new one
- New Operate destination: LINE — push data straight to a LINE chat, alongside the existing Slack and webhook channels
- API keys can now be scoped to specific reports with per-key usage metering, so embedded analytics can be sold as its own product

**Improved**
- Unified the public API's report-running path with the internal viewer — closes a rate-limit and run-history gap on the public API and adds the data-source visibility check to the internal viewer
- Notebook AI autofill now shares the same safety controls (token budget, usage tracking, multi-provider support) as the rest of the platform

**Fixed**
- Workspace templates now respect plan quotas for reports and watchers instead of bypassing them
- SCIM directory sync is now correctly gated to the Business plan
- Fixed chart colors silently drifting from the active theme in a handful of block types
- Fixed Story Mode showing the wrong currency and a non-functional "Why" button

**Security**
- Fixed a cross-tenant data exposure risk in the Metric editor and encrypted REST connector credentials at rest (they were stored in plaintext)
- Closed a SQL-guard gap that could let a crafted query smuggle a write statement past the read-only check

## [1.2.4] — 2026-08-13

Semantic Metric Layer, Cross-workspace Ask & Decision Log

**New**
- One governed definition per business metric — Ask, Brief, and Watchers now read the same number instead of each re-deriving it from their own report SQL
- Ask Curf across the whole workspace — ask a question without picking a report first
- Workspace-configurable currency (previously hardcoded to USD everywhere)
- Log a decision against a governed metric — Curf re-checks it automatically and tells you whether it moved the number the way you expected
- Entry points from the Metrics page and from Ask Curf's metric citations
- Closes the Understand → Forecast → Act → Improve loop — the first feature that tracks whether a decision actually worked

**Improved**
- Renamed "Fast Brief" to "Brief" in the sidebar

## [1.2.3] — 2026-08-07

Trustworthy AI answers

**Improved**
- When a question can't be answered from the data on hand, Curf now says exactly what data would be needed instead of guessing

## [1.2.2] — 2026-08-06

Public API & pilot rollout

**New**
- /api/v1 now exposes dashboards, watchers, and ask-chat for external frontends
- CORS support added to /api/v1 so external frontends can call the public API
- Role-based login shipped for the Zero Dropout command-center pilot

## [1.2.1] — 2026-08-05

Workspace & reliability

**New**
- New workspace creation flow

**Improved**
- Lake table addressing improvements

**Fixed**
- Responsive sidebar for small screens
- A KPI card on a background browser tab rendered 0 instead of its real value

