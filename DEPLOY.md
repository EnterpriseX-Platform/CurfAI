# Deploying Curf Community

Curf is a single Next.js service in front of a Postgres database. The `Dockerfile` builds one image with Chromium inside it for PDF export; anything that runs a Docker image runs Curf.

## What you need

- **Postgres 14+**, reachable from the app. `docker-compose.yml` in this repo starts one locally on port 5432.
- **Four environment variables.** Everything else is optional.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string, e.g. `postgres://user:pass@host:5432/curf?sslmode=require` |
| `NEXTAUTH_URL` | The full origin you serve the app at, no trailing slash |
| `NEXTAUTH_SECRET` | Session signing key. `openssl rand -base64 32` |
| `CRON_SECRET` | Protects `POST /api/cron/tick`. `openssl rand -hex 32` |

Optional: `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` for scheduled email delivery; `ANTHROPIC_API_KEY` for the auto-generate feature; `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` for social sign-in (register `{NEXTAUTH_URL}/api/auth/callback/{google|github}` with the provider). `.env.example` lists every variable with a comment.

Keep secrets in your platform's secret store, never in the repo.

## Build and run the image

```bash
docker build -t curf .
docker run -p 3100:3100 --env-file .env.production curf
curl http://localhost:3100/api/health
```

A healthy instance answers `{"status":"ok","db":"ok",...}`. A 503 means the app cannot reach the database.

Run migrations on every deploy; the command is idempotent and applies whatever is new under `prisma/migrations`:

```bash
npx prisma migrate deploy
```

Each release ships its schema change as one migration folder, so upgrading is: pull the release, build, `migrate deploy`, restart. Use `migrate deploy` rather than `prisma db push` from the start; a database created with `db push` has no migration history and `migrate deploy` will refuse to touch it later.

Optional: `prisma/rls/policies.sql` adds Postgres row-level security so the database itself enforces workspace isolation. Apply it once with `psql "$DATABASE_URL" -f prisma/rls/policies.sql`.

Seed the first workspace once, against the production database:

```bash
docker run --env-file .env.production curf npx prisma db seed
```

The seed creates `admin@curf.local` / `admin123`. Change that password before you invite anyone.

## The scheduler

Scheduled deliveries fire when something calls `POST /api/cron/tick` with the `x-cron-secret` header. Call it every minute from any scheduler (a platform cron, a Kubernetes CronJob, `curl` in a systemd timer). The endpoint is idempotent and safe to call concurrently: each schedule fires at most once per cron minute.

```bash
curl -X POST -H "x-cron-secret: $CRON_SECRET" https://curf.example.com/api/cron/tick
```

## Platform recipes

### Docker Compose

`docker-compose.yml` starts Postgres. Add the app as a second service that builds from the `Dockerfile`, takes the four variables, exposes 3100, and runs `npx prisma migrate deploy && npx next start -p 3100` as its command.

### Railway

1. New Project, deploy from GitHub, pick your fork.
2. Add the **Postgres** plugin. Railway injects `DATABASE_URL`.
3. Under **Variables**, add `NEXTAUTH_URL` (the Railway-issued domain), `NEXTAUTH_SECRET`, `CRON_SECRET`.
4. Set the **Start Command** to `npx prisma migrate deploy && npx next start -p $PORT`.
5. Add a **Cron** service that calls `/api/cron/tick` with the secret header every minute.

### Fly.io

```bash
fly launch --dockerfile
fly postgres create --name curf-db
fly postgres attach curf-db
fly secrets set NEXTAUTH_URL="https://curf.fly.dev" \
                NEXTAUTH_SECRET="$(openssl rand -base64 32)" \
                CRON_SECRET="$(openssl rand -hex 32)"
fly deploy
fly ssh console -C "npx prisma migrate deploy"
```

`fly.toml` should set `internal_port = 3100` and a `[[http_service.checks]]` entry with `path = "/api/health"`.

### Kubernetes, Render, anything else

Run the image, set the four variables, expose port 3100, point the readiness probe at `/api/health`, and run `npx prisma migrate deploy` as a pre-deploy hook or init container.

## Persistent storage

Besides Postgres, the app writes one directory: `lake/`, which holds the per-workspace file lake (CSV, XLSX and JSON uploads land here as SQLite files). Mount it on a persistent volume and back it up with the database.

## After deploying

1. `GET /api/health` returns `{"status":"ok"}`.
2. Sign in, open a report, export it to PDF. A timeout here means Chromium is not wired; check `PUPPETEER_EXECUTABLE_PATH` if you are not using the provided image.
3. Call `/api/cron/tick` with the secret and confirm it answers `{"ran": N}`.

## Sizing

- One `next start` process handles a typical reporting workload on a single core. Scale vertically first.
- PDF export forks a Chromium per render. Plan on 1 GB of memory per replica as the floor, 2 GB to be comfortable.
- Prisma's pool is conservative. Under load, append `?connection_limit=10` (or higher) to `DATABASE_URL`.

## Rolling back

Migrations are forward-only. To roll back, deploy the previous image and apply the reverse migration by hand; keep the last three images in your registry.
