# E2E suite

Playwright specs, one per journey we'd otherwise verify by hand. They drive a
real browser against a running Curf and its real database — nothing is mocked,
which is the point: these catch what unit tests structurally can't (routing,
masking as rendered, a dialog's own state, what a role actually sees).

## Running them

They need a server and a seeded database; they don't start either.

```bash
docker compose up -d      # Postgres
npm run db:seed           # the seeded admin, demo tenants and fixtures
npm run dev               # :3100 — leave running
npm run test:e2e          # in another shell
```

One spec, or one test:

```bash
npx playwright test tests/e2e/lake-formula-columns.spec.ts
npx playwright test tests/e2e/lake-formula-columns.spec.ts -g "a viewer gets none of it"
npm run test:e2e:ui       # the explorer, for writing or debugging one
```

`CURF_E2E_URL` (or `CURF_E2E_PORT`) points the suite at another server;
`CURF_E2E_AUTOSTART=1` makes Playwright start `npm run dev` itself.
`.github/workflows/e2e.yml` runs the same suite against a fresh Postgres (migrated and seeded like a
deployment), with `CURF_SIGNUP_OPEN=1` so the specs can create their own workspaces.

After a failure, `npx playwright show-trace test-results/<dir>/trace.zip`
replays it with the DOM at every step — faster than re-running with logging.

## What the environment has to offer

A spec skips (never fails) when the thing it needs isn't there, so the suite
stays green on a machine that isn't set up for everything:

- **The seeded admin** — `admin@curf.local` / `admin123`, from `npm run db:seed`.
- **Some fixture workspaces** (`a3-verify` and its apps) — specs that need one
  skip when it's absent.
- **No SMTP** — invite and reset flows hand the accept link back in the API
  response only when mail isn't configured, which is how a spec gives a new
  member a password. With SMTP set, those specs skip.
- **A model** (`CURF_LLM*`) — anything that asks Curf to write something skips
  without one.
- **Open signup** — `signupTenant()` in `helpers.ts` calls `/api/signup`, which
  is invite-only unless `CURF_SIGNUP_OPEN=1`. Set it for the specs that build
  their own workspace, or prefer the seeded admin plus an invite.

## Writing one

- Keep each spec to one journey, and say in the file's doc comment what that
  journey is and why the shape of the test follows from it.
- `test.describe.configure({ mode: "serial" })` — the tests share a database
  and one server-side session map; parallel runs surface 401s.
- Set up through the API (`page.request`), assert through the browser. Setup
  by hand in the UI is slow and fails for reasons that aren't the point.
- Name fixtures with a timestamp (`orders_e2e_${Date.now()}`) so a re-run
  doesn't collide with the last one's leftovers.
- Against a dev server, the first request to a route pays for its compile.
  Warm the routes a journey waits on during setup, and give first-time waits
  room — a 30s wait that's really 1s of work plus a compile will flake.
- Wait on what the person would see (the rows, the message), not on a flag the
  UI sets optimistically — several headers mark themselves sorted before the
  rows they sort have arrived.
