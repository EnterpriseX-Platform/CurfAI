# Curf Java engine

A standalone, MIT-licensed data plane for Curf: connections and secrets, governed views, guarded query
execution, row-level security, PII masking and audit. It is sold and supported for on-premise enterprise
deployments. The SaaS build does not include it (`engines` is in the root `.dockerignore`), and nothing in
the Node app depends on it unless an engine is configured.

| Path | What |
|---|---|
| `java/` | Spring Boot 4, Java 25, Liquibase. Layers: `domain`, `application`, `infrastructure`, `interfaces` (ArchUnit-enforced); `config` wires them |
| `contracts/` | `engine-v1.openapi.yaml`, the contract every engine implements, linted with Spectral |
| `conformance/` | HTTP-level test suite and the shared SQL attack corpus any implementation must pass |

## Status

- **M0 foundations:** identity from any OIDC issuer, `GET /me`, append-only audit, RFC 9457 errors, health and
  Prometheus, Liquibase with rollback, non-root image, CI.
- **M1 connections and query core:** encrypted connection secrets, PostgreSQL / MySQL / MariaDB, test and
  introspect, a parser-based SQL guard, read-only execution with timeout, row and byte caps, per-viewer
  concurrency limit, viewer-scoped cache, provenance hash, query log.

- **M2 views and policy:** views with a draft and publish step, row-level security by viewer attributes (from the
  token, else an entitlement table), personal-data masking and hiding by role, structured filters, grouping and
  aggregates that can only reach what the viewer may see, a catalogue per viewer, previews, versions.

- **M3 reports and run:** Curf's own report definition stored as sent, with a numbered version for every save and
  restore; run as the person asking; checked against Curf's real Node runner.

- **M4 exports:** a report as CSV, XLSX, DOCX or PDF, run as the person asking, kept briefly with its SHA-256.

- **M5 sharing and publishing:** shares, maker-and-checker publish approval, public links and embed tokens.

- **M6 scheduler:** reports mailed on a timetable, claimed once however many instances run.

- **M7 Oracle and SQL Server:** two more database kinds behind the same guard, views, row rules and masking.

- **M8 Trino:** an optional fifth kind (catalog or `catalog.schema` as the database). Trino's permissions live in its
  own access-control configuration, which a query cannot reveal, so the connection test says it cannot verify the
  account is read-only and the read-only transaction and the guard carry it: give the account only SELECT in Trino.

- **Curf integration:** Curf can use the engine as an alternative query engine, per data source (see below).

Next: hardening.

## Using the engine from Curf

Curf reaches the engine through a data source of kind `engine` (Enterprise tier, feature `connector.engine`). A query
on it names a **published view** and what to ask of it (columns, filters, grouping, aggregates, ordering, limit) in
the `engine` field of the report's query, the same format the engine's own report definitions use (including
`{"$param": "name"}` values and `skipIfEmpty` filters). Curf sends it to `POST /engine/v1/queries/execute` as the
person running the report, so the engine's row rules and personal-data masking decide what comes back.

- **Identity.** Curf signs a one-minute RS256 token per query (`src/lib/engine/identity.ts`) naming the person
  (`sub`), the workspace (`tenant`) and their roles (`realm_access.roles`). Curf's custom role slugs pass through,
  because a view's `allowedRoles` / `piiRoles` name them, **except the engine's own names**: `curf-*` and `public`
  are dropped, so a custom role cannot be called `curf-approver` to gain the engine's permissions. An admin is
  `curf-admin` inside that workspace only, everyone else `curf-viewer`. The token's `aud` is the engine's own
  address unless the connection sets one (configure the engine's audience to match to make a token useless at any
  other engine). The engine fetches the public key set from `GET <curf>/api/engine/jwks`. Engine settings:
  `CURF_ENGINE_SECURITY_ISSUERS_0_ISSUER=<CURF_ENGINE_ISSUER>`, `..._JWKSETURI=<curf>/api/engine/jwks`,
  `CURF_ENGINE_SECURITY_CLAIMS_TENANT=tenant`. Curf's side: `CURF_ENGINE_SIGNING_KEY` (see `.env.example`).
  **Rotating the key:** set the new key, move the old one to `CURF_ENGINE_SIGNING_KEY_PREVIOUS`; both are published,
  only the new one signs, so tokens in flight stay valid. Remove the old one a few minutes later.
- **Where the engine is.** One platform engine (`CURF_ENGINE_URL`) serves every workspace, which the tenant claim
  keeps apart; or a workspace gives a data source its own engine URL (an engine inside its own network). A
  workspace's URL is an address and nothing more (no path, query or credentials), must be `https`, and must be
  public: the connection checks the address it is really about to use, so a DNS answer that changes between the
  check and the connection has nothing to flip. The operator may list hosts in `CURF_ENGINE_ALLOWED_HOSTS`
  (`host` or `host:port`) for an engine on the same network, and a listed host may use `http`. The platform URL is
  operator configuration and trusted as written. Answers are read up to 32 MB.
- **Who holds which attribute: Curf is the source of truth.** What a person holds for a row rule (an agency code, a
  region) is kept in Curf (`UserAttribute`, one row per person, attribute name and value) and edited in the admin
  console's *People & access* tab, one person at a time or imported from a spreadsheet. A change is written through
  to the engine's entitlement table at once (`PUT /engine/v1/policies/entitlements`, keyed by the Curf user id, which
  is the `sub` of the token), to every engine the workspace uses. The engine's entitlement API *replaces*, so
  Curf sends a person's complete set for an attribute, and an empty set removes it. A *drift check* lists who is
  missing on the engine (they would see too little) and who is extra there (they might see rows Curf would not give
  them), and *Sync now* makes the engine match, sending only what differs. A person with no value for an attribute
  a view's rule names sees **no rows**, never all rows.
- **One console.** An admin manages an engine from `/connections/engine/<id>` and never meets the engine's API:
  *Status* (a connection test that says which step fails and what to change — reachable, accepts Curf's token,
  the right workspace, how many views), *People & access*, *Views* (create from a table or a SELECT, choose
  masking per column, who may query, row rules, publish) and *Databases* (the engine's own connections to the
  customer's databases, with a read-only check). The screens call the engine through one guarded proxy
  (`/api/engine/admin/…`) that allows a fixed list of paths and methods, only for admins, and audits every change
  (method and path, never the body: a connection holds a password).
- **Building a report.** In the report designer, a query on an engine data source has its own editor (no SQL): pick a
  view, choose columns, filters (bound to report parameters, or ignored when empty), totals, sort and a preview as
  yourself. *Describe what you want* proposes a query from a sentence: the model sees only the catalogue of views
  and columns the person may use (and which are masked for them), never data, and its answer is checked in code
  against that catalogue before it can be used.
- **Public (anonymous) access is explicit, per view.** A visitor with no account (a public link, an embed) reaches
  the engine as the reserved role `public` and nothing else. The engine serves them only views whose allowed roles
  include `public`, and it refuses to save such a view if it has row rules or an unmasked column that looks like
  personal data. Any other view answers "not available". Nothing is public by default or by side effect.
- **Not cached, not stored.** Engine answers are per person, so Curf never puts them in its shared query cache and
  never keeps them in a saved run (`ReportRun`: replay, history, diff, watchers and the Brief read those and show
  them to other people; a test fails any new write path that skips `snapshotOf()`). A run as the system (no person
  to answer for) returns nothing with a reason. A watcher on engine data therefore checks the rows it has now,
  without a stored baseline to diff against.
- **What is not there yet.** REST sources and cross-source joins stay on Curf's own runner; the engine's own report
  store, exports and schedules are not used by Curf, which keeps its own. AI features that send sample rows to a
  model provider (chart suggestions, summaries) send an engine report's rows as the person may see them; there is
  no per-connection "never send to AI" switch yet.

## Sharing and publishing

- **Who may do what with a report** is decided in one place: the `report:edit` permission, the report's run roles, and
  shares (a person, a group, or everyone holding an attribute value such as an agency code; `VIEW` or `EDIT`, optionally
  expiring). The highest level wins. Someone with no access gets 404, the same answer whether the report exists or not.
- **People who only run a report get its published version**, never the working copy; a report that was never published
  (or was withdrawn) is not there for them. Editors run the working copy.
- **Maker and checker:** `report:publish-request` asks for the newest version to be published; a different person with
  `report:approve` decides (`CURF_SEGREGATION_OF_DUTIES` otherwise). Approving publishes exactly the requested version; a
  report saved since makes the request stale (409). Rejecting needs a note, unpublishing needs a reason, both are audited.
- **Public links and embed tokens** let someone without an account run a published report. The secret is shown once and
  only its hash is stored. The public runs as the reserved role `public`: only views that list it, have no row rules and
  show no unmasked personal-looking column are reachable (checked when the view is published, when the link is made and
  on every use), and a report with a raw SQL query can never be public. Links expire (30 days by default, 365 at most; embed
  tokens 1 hour, 24 at most), can be revoked at once, fix parameters whatever the caller sends, are rate limited
  (`curf.engine.public.runs-per-minute`, default 30), and every failure is the same 404. Browsers may call the public
  endpoints only from `curf.engine.public.allowed-origins`. Exports are not offered publicly.

## Exports

`POST /engine/v1/reports/{id}/exports` runs the report **as the caller** (their rows, their masks) and writes a file.
Only the creator can fetch it (`GET /exports/{id}/file`, with `X-Content-SHA256` and `X-Curf-As-Of`), and it is
deleted after the retention period (default 7 days, `curf.engine.exports.retention`).

| Format | What it holds |
|---|---|
| CSV | One table block (the first, or `blockId`), machine-readable values, UTF-8 with a byte-order mark so Excel reads Thai. Text a spreadsheet could read as a formula is prefixed with `'`. Refused when the table's data did not load or there is no table, as in Curf's own export |
| XLSX | One sheet per table block, a provenance sheet, real numbers, money and percent formats, real dates (text when a Buddhist-era year is wanted). Text is never a formula. Streams, so 100,000 rows are fine |
| DOCX | The tables, totals, a table of data sources and a footer. No charts, as in Curf's Word export |
| PDF | The same content printed by headless Chromium (a Gotenberg sidecar) with the Thai font (Sarabun, OFL) embedded, so stacked vowels and tone marks are right anywhere |

Defaults and rules:

- **Thai by default**: Thai words in the file, Thai month names, Buddhist-era years (พ.ศ. = year + 543), ฿. Ask for
  `locale: en`, `calendar: GREGORIAN` or another `currency`; a report that fixes `dateEra` or `currency` wins.
- **Nothing silently incomplete**: a result cut short by the export row limit (default 100,000 per query) is refused
  with 422 `CURF_ROW_LIMIT`. A table whose query failed or was denied is marked as such in XLSX, DOCX and PDF.
- **The file says where it came from**: as-of time, report version, parameters and each query's hashes are written into
  it (XLSX and DOCX properties, a provenance sheet or table, the PDF footer). The hashes equal the ones a run reports.
- **Safe to open**: HTML for the PDF is built with every value escaped, no script, and a content security policy that
  forbids any request. Run the sidecar with no route out of the cluster.
- **Fonts**: XLSX and DOCX cannot embed a font; they name `curf.engine.exports.font` (default TH Sarabun New). The PDF
  embeds its own.

PDF needs the sidecar: set `CURF_ENGINE_GOTENBERG_URL` (for example `http://gotenberg:3000`, image
`gotenberg/gotenberg:8`). Without it PDF answers 503 `CURF_EXPORT_UNAVAILABLE` and the other formats work.

Not done: charts in any format (tables only), and printing Curf's own viewer for the PDF, which needs a render route on
the Curf side. The engine prints its own page instead.

## Reports

A report is **Curf's own definition JSON**, stored verbatim; the engine reads only `parameters`, `dataSources` and
which queries blocks use, and keeps pages, blocks and themes untouched, so the Curf UI renders from the same
document. Every save keeps a numbered copy; restoring adds a new version holding the old definition.

Each `dataSources[]` query is bound to the engine in one of two ways:

- **`engine`** (governed): a published view plus structured parts (`columns`, `filters`, `groupBy`, `aggregates`,
  `orderBy`, `limit`, view `params`). It runs **as the person running the report**, so their row rules and masking
  apply. A value may be `{"$param": "from"}` to use a report parameter, and a filter with `skipIfEmpty` is dropped when
  its parameter is blank (Curf's "blank means no filter").
- **`sql`** (raw): Curf-style SQL with `:name` parameters on an engine connection. Only for `view:manage` holders on
  connections that allow raw SQL; for anyone else the query is marked `accessDeniedNote`.

Running follows Curf's runner: every declared parameter is bound (its default, or an empty string) and the engine
rejects values that cannot be what the parameter says (Curf would hand them to the database); queries used only by a
drill-down are skipped; and a failing query leaves an empty dataset and an `executionError` in its provenance while
the rest of the report runs. The answer has Curf's shape: `{dataset, provenance, params}` plus `reportVersion` and
`asOf`. Provenance `queryHash` and `dataHash` are computed by Curf's own algorithms and pinned to Curf's output by
tests, so they match.

Who may run a report: people with `report:edit`, and anyone holding one of the report's `runRoles`. Someone who may only
run a report gets its definition with each query reduced to `id` and `name`: no SQL, bindings or data source ids.
Sharing with people and groups, and publish approval, are in the section above.

**Checked against the real thing.** `conformance/parity/` runs a report through Curf's actual Node runner and through
the engine and compares them. On the recorded run all 64 checks were identical (rows, counts, both hashes, failures).
It also found the one deliberate difference: Curf's Node driver renders a `date` column as a timestamp that shifts with
the server's time zone, the engine returns the plain date.

Not supported yet: REST sources, cross-source joins and attached sources (a report using them is refused on save, with
the reason).

## Views, row rules and personal data

A **view** is an administrator's SELECT plus a policy. Ordinary viewers never run SQL; they send a structured
request (columns, filters, grouping, aggregates, ordering) against a **published snapshot** of a view.

- **Row rules.** `{column, operator, attribute}`: a viewer sees only rows whose column holds one of their values
  for the attribute (an agency code, say). A viewer with no value sees **no rows**, never all rows. Values come
  from the token claim when it is configured under `curf.engine.security.claims.attributes`, otherwise from the
  entitlement table (`PUT /engine/v1/policies/entitlements`). `bypassRoles` are exempt (for auditors).
- **Personal data.** Each column is `NONE`, `MASK` (text becomes a constant, anything else NULL) or `HIDE`
  (not offered). Columns whose names look like personal data start masked or hidden until someone decides
  otherwise. `piiRoles` see everything as it is. Managing views does not unlock personal data.
- **Two-level statement.** The engine runs
  `SELECT <asked> FROM (SELECT <visible columns, masked ones replaced> FROM (<view sql>) v WHERE <row rules>) m
  WHERE <filters> GROUP BY ... ORDER BY ... LIMIT n`.
  The row rules and masks are applied before the viewer's request is even looked at, and everything the viewer
  names resolves against `m`, where hidden columns do not exist and masked ones already hold the mask. Names are
  checked and quoted, values are bound, and the composed text goes through the SQL guard again.
- **Publishing.** Edits change the working copy; viewers keep seeing the published version until it is published
  again. Unknown, unpublished and not-allowed views all answer 404, so views cannot be discovered.
- **Caching.** The cache key is the composed statement and its bound values, so two viewers share a cached answer
  exactly when their policy outcome is identical.
- **Raw SQL lane.** Administrators on connections that allow it can still run raw SQL. It is not subject to row
  rules; keep it for trusted administrators and leave `allowRawSql` off elsewhere.

Known limits: timestamps in filters are compared in the database's time zone; a `view` statement's columns need
plain names (alias expressions); one tenant's entitlements never apply to another.

## How a statement is made safe

1. The statement must parse as exactly one `SELECT`. Anything else, or anything that does not parse, is refused
   (`CURF_SQL_REJECTED`). Nested `WITH` data changes, `INTO`, locking reads, file, program, network and sleep
   functions, and credential tables are refused anywhere in the tree.
2. The engine runs the text **rendered from the parsed tree**, not what the caller sent, so hidden comments
   cannot carry anything. MySQL executable comments and optimizer hints are refused outright.
3. Values are bound as named parameters, never concatenated.
4. It runs in a **read-only transaction that is always rolled back**, with a server-side and a driver timeout,
   a row cap and a byte cap. Tests prove this alone stops DML and DDL on writable accounts.
5. The connection test inspects the database account and reports `readOnlyVerified`. **Use a SELECT-only
   account**; that remains the real control and these layers are in front of it.

Known limits of the guard: it uses one SQL grammar for all dialects, so unusual dialect-only syntax is refused
rather than guessed at; the attack corpus lives in `conformance/corpus/guard.json` and grows with findings.

## Run it

The engine refuses to start without a database, a master key and at least one trusted issuer (no defaults).

```bash
docker build -t curf-engine engines/java
docker run --rm -p 8080:8080 \
  -e CURF_ENGINE_DB_URL=jdbc:postgresql://host:5432/engine \
  -e CURF_ENGINE_DB_USER=engine -e CURF_ENGINE_DB_PASSWORD=... \
  -e CURF_ENGINE_MASTER_KEY=$(openssl rand -base64 32) \
  -e CURF_ENGINE_SECURITY_ISSUERS_0_ISSUER=https://idp.example/realms/main \
  -e CURF_ENGINE_SECURITY_ISSUERS_0_JWKSETURI=https://idp.example/realms/main/protocol/openid-connect/certs \
  curf-engine
```

Keep the master key: without it stored connection passwords cannot be read. To rotate, set
`CURF_ENGINE_MASTER_KEY_ID` and `CURF_ENGINE_MASTER_KEY` to the new pair and list the old pair under
`curf.engine.secrets.previous-keys`.

Which claims carry roles, groups, attributes (for example an agency code used by row-level security) and the
tenant is configuration under `curf.engine.security.claims.*`. Roles map to permissions under
`curf.engine.security.role-permissions`. Query ceilings live under `curf.engine.query.*`. Connections to
loopback addresses are refused unless `curf.engine.connections.allow-loopback=true`; link-local and metadata
addresses are always refused.

## Test it

Integration tests need a PostgreSQL (`CURF_ENGINE_DB_URL`, `CURF_ENGINE_DB_USER`, `CURF_ENGINE_DB_PASSWORD`); they
also run against MySQL and MariaDB when `CURF_ENGINE_TEST_MYSQL_HOST/PORT`, `CURF_ENGINE_TEST_MARIADB_HOST/PORT`
and `CURF_ENGINE_TEST_ROOT_PASSWORD` are set, against Oracle when `CURF_ENGINE_TEST_ORACLE_HOST/PORT/PASSWORD` are (Oracle Free: service
`FREEPDB1`, admin `system`), and against SQL Server when `CURF_ENGINE_TEST_MSSQL_HOST/PORT/PASSWORD` are (admin `sa`). Without a database they are skipped and the coverage gate fails.

```bash
cd engines/java && gradle check
# conformance, against a running engine and the stand-in identity provider:
cd engines/conformance && node tools/mock-idp.mjs &        # then see README there for the environment
```

## Operating notes

- `/engine/v1/actuator/health/**` and `/engine/v1/actuator/prometheus` are open (no token) so probes and
  scrapers work; restrict them at the network edge.
- Database messages shown for a failed statement come from the database and may contain object names.
- Oracle's JDBC driver is not OSI-licensed and is never bundled. Mount it at `/opt/curf/drivers`.

## Scheduled delivery

`POST /engine/v1/schedules` sends a report by email on a timetable: five-field cron in a time zone, a format, a locale,
report parameters and recipients.

- **Runs as the person who saved it.** A scheduled run has no token, so it uses a copy of that person's roles, groups and
  attributes: their row rules and masking apply exactly as if they had run the report, and the same access to the report is
  checked on every run. Saving again re-copies it, so nobody can give a schedule more access than they hold.
- **Once per fire, on any number of instances.** A fire is claimed with a single atomic database step (the schedule's next
  fire time moves forward together with a unique run record), so two engines ticking at the same moment fire it once. An
  engine that was down runs a schedule once when it returns, not once per missed fire.
- **Retries and crashes.** A failure that may pass (mail server or PDF printer down) waits and retries with growing waits
  (`retry-backoff`, default 2 minutes, doubling, `max-attempts` 3); one that will not (no mail server configured, the person
  lost access, a file over the attachment limit) fails at once. A run whose instance died is taken over when its lease
  (`lease`, default 15 minutes) ends. Delivery is at least once.
- **Fails closed on recipients.** `curf.engine.schedules.allowed-recipient-domains` is empty by default, so nothing can be
  mailed until an operator allows a domain (subdomains included). A schedule cannot fire more often than `min-interval`
  (default 5 minutes).
- **Mail** goes through the SMTP server in `spring.mail.*` (`spring.mail.host`, `port`, `username`, `password`, ...), one
  message per recipient with the file attached and its SHA-256 in the body; `curf.engine.schedules.mail-from` sets the sender.
- Set `curf.engine.schedules.enabled=false` on an instance that should not pick up work.

## Oracle and SQL Server

Create a connection with `kind` `ORACLE` or `SQLSERVER`. The drivers (`ojdbc11`, `mssql-jdbc`) ship in the image.

| | Oracle | SQL Server |
|---|---|---|
| `database` | the **service name** (for example `FREEPDB1`) | the database name |
| TLS | `DISABLE` is plain tcp; `REQUIRE` and `VERIFY` use tcps, and `VERIFY` also matches the server's name. The server certificate must be trusted by the JVM's trust store (import the CA into it) | `encrypt` is on unless `DISABLE`; `VERIFY` also validates the certificate |
| Row limit | `FETCH FIRST n ROWS ONLY` | `SELECT TOP n` |
| Read-only transaction | yes for DML (`SET TRANSACTION READ ONLY`); **DDL ends the transaction with an implicit commit, so it is not stopped there** | none (the driver's read-only flag is only a hint); DDL is transactional, so the always-rollback undoes it |
| What stands in front | the guard, then the account's rights | the guard, then the account's rights |
| Privilege check | `session_privs` and object grants through roles | `fn_my_permissions` at database and server level |

Because neither database makes the transaction a complete barrier, **use a SELECT-only account**; the connection test reports
`readOnlyVerified: false` and names every write or administrative privilege it finds. Write view SQL for the database it runs on
(Oracle needs `FROM dual`, no `AS` before a table alias, no `LIMIT`; SQL Server needs no `ORDER BY` inside a derived table). On Oracle,
unquoted names are stored in upper case and the engine quotes every name exactly as the database reports it, so a column created as
`AMOUNT` is `AMOUNT` in views, rules and filters. Oracle `DATE` values carry a time and are returned as timestamps; `NUMBER` values are
returned as text so no precision is lost. The guard also refuses password-hash and database-link tables (`user$`, `link$`,
`dba_db_links`, `sql_logins`, `syslogins`) and the file and trace functions of each database.
