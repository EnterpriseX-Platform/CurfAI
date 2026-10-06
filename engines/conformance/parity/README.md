# Parity with Curf's own runner

Runs one report through **Curf's real Node runner** (`src/lib/reporting/runner.ts`) and through the engine, then
compares the results query by query: rows, row counts, `queryHash`, `dataHash` and failures. It is the check that
the engine can stand in for the Node runner on a Postgres source. It is run by hand (it needs Curf's dependencies
and a database for Curf's own metadata), not in CI.

## Run it

```bash
# 1. Curf: dependencies, client, a throwaway database for its metadata
npm ci --ignore-scripts && DATABASE_URL=postgresql://curf:curf@localhost:55433/curf npx prisma generate
docker run -d --name curf-parity-db -p 55433:5432 -e POSTGRES_USER=curf -e POSTGRES_PASSWORD=curf -e POSTGRES_DB=curf postgres:16-alpine
DATABASE_URL=postgresql://curf:curf@localhost:55433/curf npx prisma migrate deploy

# 2. The data both sides read: load ../fixtures/agency_data.sql into a test Postgres and give a SELECT-only
#    account named curf_reader (password Pw-test-1) access to it.

# 3. Curf's runner
DATABASE_URL=postgresql://curf:curf@localhost:55433/curf CURF_SECRET_KEY=any-long-test-secret \
TARGET_HOST=localhost TARGET_PORT=55432 TARGET_DB=engine OUT=curf-out.json \
npx tsx --tsconfig engines/conformance/parity/tsconfig.json engines/conformance/parity/curf-runner.mts

# 4. The engine (running, with the stand-in identity provider, see ../README.md), and the comparison
ENGINE_URL=http://localhost:8080/engine/v1 ENGINE_IDP_URL=http://localhost:9099 CURF_OUT=curf-out.json \
ENGINE_TARGET_HOST=<host as the engine sees it> ENGINE_TARGET_PORT=55432 ENGINE_TARGET_DATABASE=engine \
node engines/conformance/parity/compare.mjs
```

`ssrfStub.ts` only switches off Curf's refusal to connect to private addresses (the hosted edition refuses them and
the test database is on this machine). Nothing in Curf's own code is changed.

## What it found

On the recorded run (two parameter sets, seven queries each, 64 checks) everything was identical: rows,
row counts, both hashes and the failing query. Numerics and bigints (`COUNT(*)`, sums) as text, float casts, Thai
text, empty results. The two differences are deliberate and are not counted as failures:

- **Dates.** Curf's Node driver turns a `date` column into a timestamp at local midnight in the server's time zone
  (a 10 January date came out as `2026-01-09T17:00:00.000Z` on a UTC+7 machine, so it changes with the machine).
  The engine returns the plain date, `2026-01-10`. A report whose rows carry date columns therefore has a different
  `dataHash` from Curf's, and the dates are the right ones.
- **Error text.** Both report the failure; the engine prefixes the database's message with its own.

Governed queries (a view plus a structured request) have no Node equivalent to compare with; they are covered by the
integration tests.
