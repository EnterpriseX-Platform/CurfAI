# Engine conformance suite

HTTP-level tests that any implementation of `engines/contracts/engine-v1.openapi.yaml` must pass. It has no
dependencies and uses Node's built-in test runner.

```bash
ENGINE_URL=http://localhost:8080/engine/v1 npm test
# optional, enables the authenticated tests:
ENGINE_TOKEN_ADMIN=<jwt with every permission> ENGINE_TOKEN_VIEWER=<jwt with none> npm test
```

Tests that need a token are skipped (and say so) when it is not provided.

The SQL guard suite also needs a prepared database: a table `guard_probe(id int primary key, label varchar(50))`
holding `(1,'one'),(2,'two'),(3,'three')`, one account that can write and one that can only SELECT, and
`ENGINE_TARGET_KIND`, `_HOST`, `_PORT`, `_DATABASE`, `_WRITER_USER`, `_READER_USER`, `_PASSWORD`. The suite
creates and removes its own engine connections.

The policy suite also needs `fixtures/agency_data.sql` loaded in that database (with SELECT for the read-only
account), the engine configured to read the `agency_code` claim as an attribute
(`CURF_ENGINE_SECURITY_CLAIMS_ATTRIBUTES_0=agency_code`), and `ENGINE_IDP_URL` pointing at the stand-in provider
so it can mint tokens for people with different roles and agencies.

No identity provider handy? `node tools/mock-idp.mjs --port 9099` serves a JWKS at `/jwks` (point the engine's
issuer at it) and mints tokens at `/token?sub=admin&tenant=t1&roles=curf-admin`. It is for tests only.

## Where each milestone adds tests

Write the section for a milestone before the feature, so the suite defines done.

| Milestone | File | Covers |
|---|---|---|
| M0 | `foundations.test.mjs` | Open health, 401/403/422/404 as problem+json, no stack traces, `/me`, audit |
| M1 (done) | `guard.test.mjs`, `corpus/guard.json` | Attack corpus must be rejected (stacked statements, `WITH ... DELETE`, `INTO`, file/OS functions), harmless keyword-lookalikes accepted, writable and read-only accounts, row cap, provenance, secrets never in responses |
| M2 (done) | `policy.test.mjs`, `fixtures/agency_data.sql` | RLS (different viewers, no attribute = no rows, bypass role, entitlement table), PII masking and hiding by role, bypass attempts, aggregates inside the row rules, cache shared only on identical policy outcome, drafts invisible, manager-only endpoints |
| M3 (done) | `reports.test.mjs`, `parity/` | Curf's definition stored verbatim with versions and restore, run shape and per-viewer rows, parameters applied and checked, drill-only queries skipped, one failing query isolated, raw SQL for administrators only, runners see no SQL; `parity/` compares with Curf's real Node runner |
| M4 (done) | `exports.test.mjs` | CSV with BOM and the viewer's own rows and masks, hash headers match the bytes, XLSX and DOCX are real Office files, only the creator can fetch, bad requests refused, PDF when `ENGINE_PDF=1`; the JVM suite reads the Office files back and extracts Thai text from PDFs |
| M5+ | `sharing`, `scheduler` | As in the build plan |
