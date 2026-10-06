# Changelog

All notable changes to CurfAI. The in-app version (with Thai and Chinese translations) lives at `/admin/release-log`; this file mirrors it in English, generated from the same source — see `scripts/gen-changelog.ts`.

## [1.4.14] — 2026-09-30

A deeper look from Ask, formula columns and the spreadsheet view

**New**
- A deeper look: when the reports can't settle a question, Ask Curf offers to plan a deeper look across your tables and documents. It shows its plan and the most it can cost, runs only once you approve, and every finding names the query it rests on.
- Ask keeps your conversations to reopen later. A deeper look tells you when it's done, and "What should we do?" hands what it found to the Strategist.
- Formula columns: add a column worked out from the others with a spreadsheet-style formula, checked as you type, or describe it and Curf writes the formula. A formula column is masked wherever the columns it reads are.
- Open any table as a spreadsheet: the whole table full screen, a million rows scrolling like a hundred, with sort, find and resizable columns.
- The Brief's "Needs you" lists your Strategist targets that are behind plan, with how many mornings running and a link to the memo.
- A Strategist memo shows charts under its findings, on the page and in the PDF — drawn only from findings its own queries settled.
- A finished Strategist memo can be presented as a slide deck, each slide titled with its conclusion, and its paper downloaded as an editable Word document.

**Improved**
- When no report has the answer but one of your tables does, Ask points you to that table instead of asking you to upload data.
- Sorting and searching a big table in the spreadsheet view no longer slows the app down for everyone else, a very long table no longer fills the browser's memory, and the sidebar's counts load in one request.
- A deeper look's progress and errors, the column editor's messages and Ask's own replies read in your language, Chinese included.
- Pages load only your language's text, in a file your browser keeps between visits: about a third of what every page downloaded before.
- The Approvals count in the executive view updates as soon as you decide or cancel a request, and moving between pages no longer asks the server for it each time.
- A Strategist memo's figures follow the approved design: the latest year highlighted with the gap to target named, a monthly running total against the pace to target, and open projects with their progress and days late. Every note on a figure is checked against the memo's own numbers.
- A POS file of one day's sales with no date column imports as it is: the day is read from the file name and shown for you to check, the column layout is remembered for the next day's file, and importing a day again replaces it.
- An empty forecast, list of items bought together or list of promotions now says what it is waiting for: 14 days of sales, receipt numbers, or promotion codes.

**Fixed**
- Strategist memos are no longer cut off part-way, deleting a document clears its pending indexing, the Developer role shows its name, and pages no longer make requests your role can't use.
- A column called "Row ID" keeps its own values in the spreadsheet view, sorting and finding in large tables are several times faster, and a formula too complex to work out is refused with a message instead of slowing the server.
- A chart across a period — a fiscal year, say — runs in time order, and a Strategist memo with a label a little too long is trimmed to fit instead of failing.
- Master Builder carries a report's new name to everything that uses it, and the chat can change an app. An app's card on Home reads in your language, and renaming an app sticks.
- The data-quality schema check counts formula columns the same on every engine, a saved Ask question is never kept without its answer, and the table page offers only the changes you're allowed to make.
- A chart's reference-line label stays inside the plot instead of being cut off, and bar charts can highlight the latest period.
- The spreadsheet view scrolls past a million rows in every browser. It used to stop at about a million rows in Chrome and 560,000 in Firefox.
- Dashboard cards and Story mode show each chart and table with its report's own colours, currency, date style and translations, the same as the report does, and an empty progress block says so in your language.
- The summary tables the retail pack builds no longer count towards a workspace's table limit. A Community workspace was full after its first sales file, and the next day's file was refused.
- Sales imported without receipt numbers no longer show orders, an average ticket or items per order — those were counted from the file's lines. The overview shows units sold and the average price instead, and the weekly summary shows sales alone. Where only some days have receipt numbers, the average ticket uses those days only.
- A cost of 0 in a sales or stock file is read as not entered, so an item is no longer shown at a 100% margin. It appears in the list of items with no cost instead.
- When the AI provider's account has run out of credit, Curf says so and says an admin needs to top it up or connect another key. It used to say the rate limit was exceeded and to wait a moment, which never helped.
- A chart set to the AI forecast is labelled “AI forecast” only when the model's own numbers are drawn. When the provider can't answer, the chart shows the straight-line forecast and names it as one. The range around an AI forecast no longer goes below zero for figures that were never negative, such as sales.

**Security**
- Column sample values in the table list and column editor are masked the same way as the table's rows, a table can only be changed by someone who can read it, and report-scoped API keys can't reach tables or documents.
- AI research is counted against your AI credits however a run ends — paused, retried or stopped at its limit — and starting research is limited per person, with a total budget per run.
- A deeper look or a Strategist question: at most two of yours work at once, starting research is limited per person, and one paused on one server stops on every server.
- The data agent lists activation settings for admins only, and a failed AI run says what went wrong in our own words — never the AI provider's or the system's error text.
- The Strategist's web search checks every query against the customer, supplier and member names in your workspace's own data, and never sends one that contains such a name to the search engine.

## [1.4.13] — 2026-09-28

Curf now runs on Node.js 22

**Improved**
- Master Builder: what the AI is doing while it designs your plan — the steps, a retry when its answer didn't fit, the stage on the Build button — now reads in your language instead of English.
- Horizontal bar charts show each category on one line, shortened to fit with the full name on hover — long product names no longer run into each other. Generated charts also get the height their bars need.
- The AI check on a generated report is held to rules in code: it can rename a block only in the report's own language and without technical terms, remove a block only when a rule found its words wrong, and cut a chart only when the chart's title says how many rows it shows. Captions that say they describe sample data are rewritten from the results or left out.
- Exported files keep the report's own name — a Thai report downloads as its Thai name instead of “report.xlsx” every time — for Excel, CSV, Word and PDF.
- An app's filter can have a default value; it then offers no “all” choice, for filters where all makes no sense, like a year of balance snapshots. Apps Master Builder builds on your real tables now say “real data” instead of “simulated”.
- An app filter can be typed into: type a product code or part of its name and press Enter, for choices with too many values for a dropdown. Each tab now shows only the filters that change it.

**Fixed**
- Master Builder: previewing a planned report that uses tables you already have now shows your real data, as you're allowed to see it, instead of an empty report. Reports on new tables still preview with sample data, and the preview says which one you're looking at.
- Every report Curf generates — in Master Builder, Instant Views, Auto-generate, from a prompt, or regenerated from comments — now passes the same check before it is saved: its queries run on the real data, a “Top 10” shows exactly 10 rows, a KPI or chart whose title doesn't match what its query computes is renamed or removed, and a summary stating figures the results don't show is rewritten or left out. Readers see what the check changed above the report. Master Builder's reports used to skip this check.
- Dashboards built without AI now average a ratio (such as an NPL ratio) in their tiles and charts instead of adding it up, and the tile says “Avg”, not “Total”.
- Rebuilding a Master Builder build made more than 20 minutes earlier no longer shows it as failed while it is still running, and the AI check no longer rewrites words a person or a template wrote.
- The Brief finds its headline numbers again when your newest reports have none (it reads further back), and says no numbers are pinned yet instead of “all quiet” when it has nothing to check.
- A chart no longer draws a forecast from fewer than four points. From two, a line fits exactly and showed a ±0% band, as if the projection were certain.

**Security**
- The server runtime moved from Node.js 20, which no longer receives security fixes, to Node.js 22 LTS. Nothing changes in how Curf works for you.

## [1.4.12] — 2026-09-27

Assign work from a number, LINE, a dedicated Executive view, Buddhist-era dates, and push notifications that arrive

**New**
- Assign work to a person straight from a number: an org chart, and assignments that keep the evidence, a due date, a repeat and their whole history.
- People without a Curf seat can work the assignments given to them at /work, signing in with a link sent by email.
- Assignments, approvals and the morning Brief on LINE, through Curf's official account or, on Enterprise, your organisation's own.
- Executive assistants can prepare approvals and draft assignments for the executive they support; the log records who drafted what.
- Meeting mode holds the work you assign during a meeting and sends it when the meeting ends, with a summary. Every app gets a board pack.
- The Executive view is its own area at /executive with its own sign-in; the regular console is back as it was. Not part of the Community edition.
- Goals shared across several people, a quarterly review of decisions against what was predicted, a calendar feed and voice dictation.
- Thai readers see Buddhist-era years in reports, charts, exports and the Brief, and a report can be locked to พ.ศ. or ค.ศ.
- Sales and stock files from any point-of-sale system can now go into two standard tables — Sales and Stock on hand — instead of a new table each time. The upload asks which column is which, fills in its best guess from the headers (Thai or English), lets you type the branch when the file doesn't say, and replaces a period you upload again instead of counting it twice. The next file in the same layout from the same POS is recognised and mapped the same way, so every branch's numbers end up side by side in one place.
- When a column's name is one Curf doesn't recognise, "Ask AI to match the rest" suggests which field it holds. Each suggestion is checked against the file's actual values and marked for you to confirm before anything is imported.
- Retail reports from your own sales and stock files: once a sales or stock file is in the standard tables, "Set up reports" on the Tables page creates a branch overview (sales, orders and average ticket against the previous period, the latest day, branch ranking), a stock & reorder report (what to order and how much, what's out, run-out dates, slow movers by days since the last sale) and a sales plan (next week's forecast and target per branch). Low-stock and slow-mover alerts come with it, and the key numbers are pinned to your Home and LINE morning brief. Every figure is calculated from your rows and updates with each import — nothing is estimated by AI.
- A basket & promotions report for retail: which items are bought together (with how often and how strongly — support, confidence and lift), bundle ideas, how each promotion's daily sales compare with the weeks before it along with the discount it cost, and a starting range for a new branch built from the items that sell in most of your branches.
- Drop several files on the Tables page at once — a month of daily POS exports, say — and they're reviewed one after another. Each file after the first opens on the table the one before went to, with its saved column matching already filled in, so a batch is confirm, confirm, confirm.
- The retail reports now cover every point on the shop owner's list. A new Sales insights report shows when sales come in (average sales per day by weekday and hour), when each best seller sells, the best sellers with their share of sales, and the items whose demand is rising against the 28 days before. The branch overview adds discounts given, items per order and how customers pay — cash, QR / PromptPay, card, e-wallet — with each POS's own names folded into one. The sales plan adds tomorrow's forecast, each branch against the average of all branches with the extra sales a branch would make at the average ticket, and an order plan that says what to order, how much for the target and by which day. Every figure is worked out from the shop's own sales rows.
- A weekly summary for shops, every Monday at 09:00 by email and LINE: the week's sales, orders and average ticket against the week before, and up to three things worth a look, ranked by what they're worth in sales — the branch, day, item or hour that moved the week, an item whose margin fell and why, the quietest stretch of the week with the promotion that worked best, and what to order now. Turn it on, or send this week's to yourself, from the Tables page. On LINE, "Ask a question" lets a member ask about their figures: Curf answers as that member, read-only, where the workspace lets figures onto LINE. A new Menu profitability report groups every item as a star, plowhorse, puzzle or dog by units sold and margin per unit, with what to do about each; costs come from the sales file, or the latest stock count.

**Improved**
- A calmer Executive view: the date and what needs you come first, rate changes read in percentage points everywhere, KPIs are held against plan, and an approval says what is asked, by whom and by when.
- The Decisions ledger and the quarterly decision review are part of the Business plan; tracking KPIs against plan stays on Growth.
- Baht is now the default currency: a workspace that hasn't picked one shows amounts in baht, and baht reads as ฿ (฿10.5B, ฿2,216,892.50) instead of "THB". A workspace that reports in dollars or another currency sets it under Admin → Workspace; one that already chose a currency is unchanged.

**Fixed**
- Push notifications are delivered — they never were before — and approvers get one when a step is waiting on them.
- Chart legends and tooltips show series names, a crowded bar axis keeps every label, a KPI with no change reads "— 0.0%", and the report designer fits a laptop screen.
- People working at /work see who is asking and land on their assignment, and the page works well on phones.
- Approval chains written by AI use the workspace's real roles, and the build page says "reused" rather than "skipped".
- The demo Brief tells one coherent story, bad news is never shown in green, and the Brief email reads like a brief.
- The Community edition builds again, and voice dictation says where the audio is sent.
- Uploaded files with Thai dates are read correctly: a Buddhist-era date such as 15/01/2567 was stored 543 years in the future, and Thai month names (ม.ค., มกราคม), Thai digits and amounts written as "1,200 บาท", "THB 1,200" or "1,200.-" left the whole column as text. They now become the dates and numbers they are.
- AI answers now check their percentages against the data too. A percentage that can't be worked out from the report's own numbers — an invented "35% lift", say — is flagged under the answer like any other unverified number; before, every percentage was let through unchecked.
- A report, pipeline or materialized view whose query returns more than 200,000 rows now stops with a message asking to summarise it (GROUP BY) or add a LIMIT, instead of loading every row into the server's memory — which, on a million-row table, could bring the service down for everyone.
- An Operate request opened by a watcher alert is filled in with the details of the row that fired it — the item, the branch, the value. It always started blank before.
- The morning Brief's AI-written stories are in the reader's language — Thai readers were getting English — and a scheduled Brief is written in the language of the person who set it up.
- An app built from a Thai brief now reads in Thai: report names, block titles, KPI labels and captions follow the language the brief was written in, instead of coming out in English.
- Importing a very large sales or stock file (a million rows) no longer makes Curf unresponsive for everyone else while it finishes: the final merge and the stock figures are now worked out in the background. Working out stock status for a million-item stock file is also about three times faster.
- A report query on Curf Tables that runs very long — a join without its condition, a summary over millions of rows — no longer holds up everyone else's pages while it runs. It's stopped after 30 seconds with a message saying how to narrow it.
- Master Builder on a reasoning model (such as Kimi) no longer falls back to a generic report when the model spends its whole answer budget thinking: it asks once more with thinking off. A report it still couldn't design now says so on the report and in the build summary, instead of passing as finished — and that fallback no longer adds up codes and date keys ("Total Day Sid") as if they were amounts.
- A promotion-code or discount column is now picked up when importing sales even if it's blank in the file's first few thousand rows (promotions usually run later in the period), so promotion results aren't silently empty. An amount that isn't known — a margin with no cost data, a day with no sales yet — now shows blank instead of "฿0.00", in tables, their totals and the sparklines on Home. Retail charts label their series in the report's language.
- Applying a Master Builder change can no longer run twice. A change that regenerates reports takes minutes, and a second request for it while the first was still running applied it again — every report came out twice. The second request now waits for the first, and the chat shows the change as "applying…" until it lands.
- Asking Master Builder to redo a report no longer loses what was built on it. The old report used to be deleted before its replacement existed, taking its watchers with it and leaving apps and dashboards pointing at a report that was gone. Now the new report is built first, and its watchers, scheduled deliveries, app views, Brief pins, dashboards and on-screen displays move across before the old one is removed; if the new one can't be built, the old one stays. The chat lists what moved.
- A KPI card whose figure isn’t a whole number (1.6 items per order, say) now shows it with two decimals instead of rounding it to 2, on every report. Heatmap cells under 1,000 read at the same precision as the ones beside them (456, not 456.44), and a heatmap can keep its rows and columns in the report’s own order — weekdays Sunday to Saturday, items by rank — with long item names shown in full.
- A heatmap tile whose status only picks a colour (success, warning…) no longer prints that word on the tile, and when every tile of a colour shares one code, the legend names the colour with it.

**Security**
- Push subscriptions accept only public https push services, so a notification can no longer be pointed at an internal address.
- Public share links are stored only as a hash and count against the plan's limit (Community 3, Growth 50). Every link already sent keeps working.

## [1.4.11] — 2026-09-24

What-if tabs for Analytic Apps, executives can approve requests, and every report now runs as the person reading it

**New**
- Analytic Apps can have a What-if tab (Business plan): move driver sliders and see the app's KPIs recomputed from its verified numbers, with presets, a sensitivity chart and scenarios you can save and track as a decision. Modelled numbers are never shown with a verified seal. The AI can design a What-if model from the app's “+” menu, Master Builder's industry packs come with one, and ⌘K answers “what if…” questions by setting the sliders.
- A What-if driver can also set a number parameter on the app's report tabs, so those tabs re-run their real queries under the scenario. A banner says which scenario is applied, with a “Show real numbers” link; history, exports and the Brief keep the real numbers.
- Executives can now approve Operate requests from the inbox and log decisions (including “Track as decision” from a What-if tab). Viewers stay read-only; templates, insights and the Action Center stay with builders.
- Admins can remove a member who has already joined from the workspace (Admin → Users & Roles). Before, a member could only be demoted, not removed. Their account and what they created stay.
- Curf Tables now takes large Excel and CSV files straight from the Tables page — up to 2 GB per file, instead of 50 MB. A 127 MB workbook with over a million rows uploads in pieces, shows its columns in about a second, and imports in the background with a progress bar you can leave running. The preview also warns when a sheet has exactly as many rows as Excel allows (the export was probably cut off), and offers to fix Thai or other text that was saved with the wrong encoding, restoring it exactly. A failed import can be retried without uploading the file again.

**Improved**
- A Master Builder build that skipped something — a view it couldn't make, a What-if tab it couldn't design — now lists what and why under “N issues while building” instead of looking like a clean success. Marketplace app listings say when an app includes a What-if tab, and template links now come from the listing's name.
- Signing in now always lands you in the same place, and your interface language is saved to your account, so it follows you to a new browser or device.

**Fixed**
- More of the app is translated into Thai and Chinese: the report designer's toolbar, block palette, Data drawer, property panel and block editors, the connection form, chart type names and their “why it's unavailable” tips, and the Schedules drawer.
- Opening the Connections tab of the designer's Data drawer no longer blanks the whole designer.
- Run now on a schedule shows the same “exports are busy, try again in about 30 seconds” notice as an export, instead of “Run failed” with an English server message.
- Saving a report with a cross-source join (ATTACH or hash join) now checks your plan, as intended; the check never ran before.
- Password-reset and invitation emails, block embed snippets and the links in scheduled deliveries pointed at an internal address (localhost) instead of this site, so they could not be opened. They now use the site's own address.
- Operate Insights no longer counts item-count fields such as total_items as money, and its "results were cut off" notice now refers to the period you selected rather than to all requests ever made.
- Publishing a notebook or report no longer creates a second Curf Tables connection when yours has been renamed, and never binds lake queries to another connection that happens to share the name.
- Curf Tables backups work again: manual and nightly backups, restoring from one, Master Builder's rebuild (which takes a backup first) and table branches had all been failing with a permission error. Earlier backups were never written, so the history starts from this release.
- The Action Center no longer files an unrelated activation run or audit event under a watcher's incident just because it happened within the same few hours. Events share an incident only when they concern the same report, watcher or activation, so Roll back appears only on the incident it belongs to.

**Security**
- Schedules: viewers and executives could create, edit and delete scheduled deliveries, including changing who they're sent to; an API key limited to certain reports could run, edit and delete other reports' schedules; and the schedules API could rename watchers and change digests' recipients. Each is now refused.
- Operate approval templates returned their LINE tokens, webhook tokens, signing secrets and custom headers to every member, and publishing one to the Marketplace carried its headers along. They're now stored encrypted and shown masked; a masked value left unchanged when editing keeps the stored secret. Approval steps assigned to a custom role could never be approved; now they can.
- Blocks hidden from a role are now hidden everywhere, not only on screen: their data and SQL no longer reach exports (XLSX, DOCX, CSV), the report data API, the page's own data, share and embed links, the report definition the API returns, or replays of someone else's run. A one-block embed link can no longer be used to render the whole report.
- Several features ran reports without knowing who was asking, which bypassed data-source permissions and the masking of sensitive lake columns: PDFs requested with an API key, scheduled deliveries, drill-through, Ask and Ask Curf chat (including through the public API), workspace Ask, the designer's previews, published app pages, watchers and the scheduled Brief. Each now runs as the person asking — for a schedule, as the person who set it up, and for a published app, as an anonymous visitor. Apps built on a restricted source now show those blocks as hidden to everyone, and scheduled alerts and Briefs only describe what their creator can see.
- Report history, replay, the run comparison page, KPI history and the Brief's comparisons showed data from other people's past runs as they were recorded, including from sources the reader can't see. Past runs are now shown as the reader may see them. Governed metrics are also resolved as the reader, and drill-through, Ask, Why and chart suggestions refuse blocks hidden from you.
- A report could name a data source from another workspace and read its data when a scheduled job ran it. Reports now only ever read their own workspace's sources, and saving, importing or restoring a report that names another workspace's source is refused.
- Watcher alerts and suggestions are written from the watched data as their creator saw it, yet they were listed to every member: on the Watchers page, in the Brief, app feeds, the digest email, Ask Curf chat, the agent and the API. They now appear only to people who could see that data themselves.
- A lake table's page showed its rows to any member, even when the table was private or restricted to other roles, and without masking columns tagged as sensitive. The samples sent to the AI when it builds a view or report had the same gap. Both now follow the table's access settings and masking.
- Ask Curf chat only adds to your own conversations — naming someone else's conversation id used to append a turn to it.
- Sign-ins in the audit log now record the address they came from, as other actions already did.
- Removing a member now also hands everything they kept private (dashboards, displays, data sources, tables) to the admin who removed them, still private, and revokes every API key they created in the workspace, AI-connector keys included.
- Creating a table by uploading a file now needs the admin or developer role, like every other change to Curf Tables. Viewers and executives could previously create tables through the upload endpoint; they no longer see the upload box.

## [1.4.10] — 2026-09-23

Action Center actions stick, Master Builder shows builds in progress and builds that failed, and PDF exports no longer print an error page

**New**
- A Master Builder plan that failed left no trace, so it looked afterwards as if nothing had been tried. The build page now lists your failed plans from the last 7 days with the reason each one stopped, and a Try again button that re-submits the same prompt.
- Data quality checks can now be edited and paused from the Data quality page. Previously a check with the wrong table or column had to be deleted and recreated, losing its run history. A paused check is skipped by the schedule but can still be run by hand.
- A Master Builder plan that fails part-way now keeps the steps it finished. "Continue from step N" on the Build page picks up at the step that failed instead of designing everything again from scratch; "Start over" is still there.
- Reports and app views the AI builds from a question can now combine several tables and compute a column, such as a flag for projects at risk of running out of funding. Before, each chart or KPI could only read one table, so a planned join came out as a single raw table. The AI's query may read only the tables of that report, is test-run before any block uses it, and one that can't be used is named in the report's note instead of being dropped silently.
- Roll back in the Action Center now really takes back what an activation run sent: records it created in HubSpot or Salesforce are deleted, records it updated go back to the values they had before the run, and its Slack posts are removed. The result — how many changes were undone, and why any couldn't be — is shown and kept on the incident's timeline. A webhook delivery can't be recalled, and rollback says so.

**Improved**
- A Master Builder plan keeps running in the background after you leave the build page, but coming back showed an empty form as if nothing were happening — making it easy to start a duplicate. The build page now picks the running plan back up, with its progress bar and activity log, and shows the plan for review when it finishes.
- When a prompt like "Build me Sales Analytics" matches a ready-made demo pack on a workspace that already has its own tables, Master Builder designs a plan from your data rather than dropping in sample data. Its activity log now says so up front, and points to the preset cards if you did want the demo pack.
- Deleting a table now tells you how many reports read from it and will show no data afterwards, instead of only "This cannot be undone".
- Master Builder now plans one report per view you ask for. A goal that names five views gets five reports, each with its own tab in the app, instead of being folded into one (up to six per build).

**Fixed**
- Acknowledging an incident, adding a note or rolling back in the Action Center said it worked but changed nothing — every incident got a new id each time the page loaded, and acknowledging one more than an hour old opened a separate incident instead. Incidents now keep the same id, and every action lands on exactly the incident you acted on.
- Exporting a report that was missing, or that you didn't have access to, produced a PDF of the "page not found" screen — and a scheduled delivery would email that as if it were the report. The export now fails with a clear message instead, and the schedule records the failure.
- If the periodic check that you still belong to a workspace hit a momentary database error, you could be moved to a different workspace or signed out mid-session. A failed check now leaves your session exactly where it was and simply tries again on the next request.
- "Ask this block" could answer a Thai question in English. It now replies in your interface language (or, if that's English, the language you typed the question in), the same way the workspace Ask already does.
- Dashboards using the chart-only layout showed each slide's chart title and filters above an empty space. The chart now fills the slide again, including inside Analytic App views.
- Publishing a notebook that had no SQL query — just the starter note every new notebook comes with — created an empty report with no data. Publishing now needs at least one SQL cell with a query, and a refused publish leaves nothing behind.
- Landing page: the "Every cell signed" badge no longer covers the demo result, the Light/Dark toggle on the product screenshot is no longer cut off on phones, visitors using dark mode now see the dark screenshot, the block-type count matches what the designer actually offers (15), and the demo card, sample narrative and pricing are translated into Thai and Chinese.
- The Master Builder page no longer promises 30–60 seconds for a goal you type yourself. It now says a ready-made pack is ready in under a minute and a goal in your own words usually takes 5–15 minutes.
- Publishing an app from an auto-generated report, or restoring one in Master Builder, could take a link another workspace already used, so the new app never opened at its own link. Every way of creating an app now checks links across all workspaces.
- Ask Curf: evidence bars show percentages the way the answer states them (66.7%, not 0.7%), and an answer drawn from several reports no longer divides a figure from one report by a figure from another.
- Fixed pages that failed to open with an error after today's earlier update — Ask, Connections, Decisions, Watchers, Knowledge, On-screen, the dashboards list, the report designer and several admin pages. Nothing was lost; the pages load normally again.
- A data quality check can no longer be saved against a table that isn't in the workspace, or a column that table doesn't have — saving says which one is missing. A check whose table is deleted later now reports that plainly instead of a database error.
- Fixed places that look up another workspace and had started answering "not found" after today's database isolation change: a marketplace author's profile and the Follow button, sharing a lake table with another workspace, the list of shared tables, and deleting a workspace other than the one you are in.
- The dependency graph on Admin → Lineage draws again. It loaded its drawing library from an outside CDN that the app's own security policy blocks, so it hadn't appeared in production since that policy was added on 25 August; the graph is now drawn by the app itself, nothing is loaded from outside, and it follows light and dark themes. "Copy as Mermaid" still exports it as text for docs.
- When exporting a report failed, including when the server was busy rendering other exports, the whole page was replaced by a raw error message; Re-download on the report's History page did the same. A notice now says what went wrong, or that exports are busy and when to try again, and you stay on the report. PDF now downloads like the other formats instead of opening in a new tab.

**Security**
- A REST connection whose base URL points at a private, internal or cloud-metadata address is now refused when you save it, with the reason shown on the base URL field. Requests to such addresses were already blocked when the connection ran; now you find out straight away instead of from a failed run later.
- Deploys no longer change the database with `db push --accept-data-loss`, which could drop a column and its data without warning whenever the code's schema differed from the live database. They now apply only reviewed migrations, and a release whose schema has changes no migration covers refuses to start instead — the running version keeps serving.
- Workspace isolation is now enforced by the database itself, not only by the application. The app no longer connects as a database superuser, and every table that belongs to a workspace is filtered to the workspace of the request making the query — so a single query that forgets its workspace filter still cannot read or write another workspace's data.
- Platform-level actions — such as inviting someone from the waitlist — are written to the audit log again. Since workspace isolation moved into the database earlier today, those entries, which belong to no single workspace, were being refused and silently lost.

## [1.4.9] — 2026-09-22

Master Builder reports, watchers and the report list all show what actually happened

**Improved**
- Master Builder's "your workspace is ready" tour explains what each table, report, and watcher is for — but that explanation only ever showed once. Close it, and reopening the build later showed bare names with no reminder of what anything does. Every artifact that had an explanation now keeps it, permanently.

**Fixed**
- A report Master Builder created from one of its proven layouts could publish with every block empty, and its preview never showed data either — both traced back to the report being wired to the wrong data source under the hood. Master Builder no longer offers this path when designing a report from your own data; every report it builds now stays connected to the tables it actually created.
- A watcher failed every time it checked a report that had a filter (a date range, a branch picker, and so on) — it never used the filter's own default value, so the check errored instead of running. Watchers now run with the same defaults you'd see opening the report yourself.
- A report could show "No run yet" on the Reports list even though it had genuinely run and had real data — most often right after downloading it as a PDF or Excel file, which doesn't keep its own copy of the results the way opening the report does. The list now looks back further to find the last real run instead of settling for one with nothing in it.
- A report made only of a chart (no KPI tiles) could show a blank thumbnail on the Reports list, even with real data plotted underneath — a sizing quirk collapsed the chart to zero height when it was the only thing in the card. Fixed.
- Exporting a report to PDF could carry over the "Install Curf" prompt if it happened to be showing, and always added a trailing blank page at the end regardless. Neither happens now.
- External tables, data quality checks, and notebooks could be deleted through the API but not from the screen itself — no button did it. Each now has one.
- Navigating between features showed nothing until the next page was ready — indistinguishable from the app being stuck. Every screen now shows a loading skeleton while it loads.
- A workspace that had pinned its AI model to one the provider has since retired kept failing every AI call, with no way to tell why. Affected workspaces now fall back to the provider's current model automatically.
- Previewing your own app before publishing it showed a plain "page not found," the same as it showed everyone else. It now opens normally for your own workspace while staying hidden from everyone until you publish.
- Two screens below the Growth plan (API keys, predictive watchers) showed their full setup form even though saving it would fail — you'd only find out after filling everything in. Both now show what's needed to unlock them upfront instead.
- A watcher set to "row crosses a fixed value" could be saved with no column chosen, so it silently never had anything to check. That's blocked now, and a rejected watcher form shows the real reason instead of a generic error.
- Saving a new workspace currency showed a confirmation that undersold what it actually does — it said only new reports would use it, when it's always applied to every existing report, dashboard, and AI answer immediately. The message now says what actually happens.
- Publishing an Operate template to the marketplace a second time created a duplicate listing instead of updating the first one. Publishing again now updates the existing listing and bumps its version.
- A few navigation labels (On Screen, API Explorer, Pricing) stayed in English even when the app was set to Thai or Chinese. Translated.
- A Table block with no columns chosen rendered every row with nothing in it and no explanation. It now shows a clear "no columns configured" message instead.

## [1.4.8] — 2026-09-21

Report links, external tables and paid features all check who's asking

**Improved**
- Several paid capabilities were listed on the plan comparison but never actually checked, so any plan could use them: embedding a chart in another site, cross-source joins, threshold lines, custom roles, per-person connection visibility, signed webhooks, streaming ingest, and asking questions of a report. They now match the plan you're on. Anything already set up keeps working — existing embeds still load, existing reports still open, existing webhooks still fire.
- Upgrade messages name the feature the way you would say it. Where one used to read “Rbac requires the Growth plan.” it now reads “Custom roles requires the Growth plan.” Two different upgrades also shared the single word “Publish”, which made them impossible to tell apart.

**Fixed**
- Catalog descriptions, domains, tags and the curated star could not be saved at all — every attempt failed with a 404. They save now.
- Catalog search returned an empty list instead of results when the page-size value wasn't a number.
- Enterprise workspaces were deleting lake backups after 30 days — less history than Growth (90 days) or Business (365). Enterprise now keeps backups longest, as intended.
- External tables, data quality checks and notebooks could be created but never removed, so an entry made by mistake or during a test stayed on the list for good. All three can now be deleted — and a data quality check can also be renamed, pointed at a different table, or switched off without deleting it.
- A data quality check or a SQL metric could be saved with settings it could never actually run with. The problem only appeared the first time someone pressed Run — on a row that, until now, could not be corrected or removed either. Both are checked when you save now, and the message says what is missing.

**Security**
- Closed a hole where a report's own print link could be used to open that report without signing in — and, because the link skipped the workspace check too, to open a report belonging to a different workspace. Scheduled PDF and Excel deliveries now identify themselves with a short-lived signed key instead, so they keep working exactly as before.
- Registering an external table no longer accepts an address on the server's own network or a file path on the server itself. Cloud storage locations (s3://, gs://, abfss://) and public https:// addresses work as before; reading files from the server's disk is now off unless an administrator explicitly turns it on for that deployment.
- Master Builder could give a new app the same web address as an app in a different workspace, so opening the link showed the wrong workspace's app. Names written in Thai were affected every time, because the address was built only from Latin letters and a Thai name left none.
- Master Builder's plan, iterate and apply steps now limit how many requests a workspace can send per minute, matching every other AI-backed endpoint in the product. A runaway script or shared browser tab can no longer flood the AI planner.
- Platform-level actions with no workspace yet — inviting someone to the private beta, approving or declining a waitlist request — silently produced zero audit trail, even though the action itself always succeeded. The audit log can now record an action that genuinely has no workspace attached, instead of quietly discarding it.
- If Curf's Slack integration were ever missing its signing secret, the two endpoints that receive Slack's requests answered as if nothing was wrong instead of refusing the request. They now refuse clearly until the secret is configured; signature verification itself was already correct.

## [1.4.7] — 2026-09-19

Master Builder finishes big builds instead of giving up one fix short

**Fixed**
- Fixed large Master Builder builds failing near the end with "could not produce a valid result" after the activity log said it was asking the AI to fix the problem. When a build had already retried once for more room, that retry was silently spending the one correction turn — so the correction the log promised was never actually sent. Room and corrections now have separate budgets.
- A build split into stages now applies the same automatic clean-up the single-pass path always had, so ordinary AI slips — a threshold written as 10 instead of 0.1, an approval step written as plain text — are corrected on the spot rather than failing the whole build.
- Fixed uploaded spreadsheet cells being silently emptied when their text happened to match a word the importer reads as "no value" — n/a, none, nil, unknown, tbd, a dash, or nan. In a text column these are real values: nan is Nan province, na is Namibia's country code. A 77-province upload quietly stored 76, and nothing flagged it. Text columns now keep them; blank cells and genuinely missing numbers are unchanged.

## [1.4.6] — 2026-09-18

Master Builder no longer fabricates people or coordinates, and tells you when it drops a map

**Fixed**
- Master Builder now refuses to invent a named person for a real place you already track (e.g., a village headman) or fabricate latitude/longitude columns — these are blocked at build time, not just discouraged in the prompt.
- When a planned map can't be shown because its column isn't a supported region type (Thai province, US state, or ISO-3 country), the report now says so in a visible note instead of silently omitting the map.
- Fixed Master Builder silently downgrading an AI-generated report to a bare, chart-free data dump when it couldn't figure out how two tables relate to each other — it now tries the prompt-aware report composer first, and visibly says so on the report itself when it still can't.

## [1.4.5] — 2026-09-17

Fixed intermittent sign-in/session errors for accounts with many workspaces

**Fixed**
- Your session cookie no longer grows with how many workspaces or organizations you belong to — accounts with a lot of memberships could hit an oversized-cookie limit that intermittently broke sign-in and page loads. Workspace switching and Platform Admin oversight are unaffected.

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

