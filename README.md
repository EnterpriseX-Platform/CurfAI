# Curf Community Edition

The open-source edition of [Curf](https://curf.ai) — a living-reports platform. Build block-based reports over Postgres, MySQL, SQLite or any REST API, export them pixel-identical to PDF, Excel, Word and CSV, and schedule them by email. Every number carries a SHA-256 proof of the query and rows that produced it.

Community is the same product as Curf Cloud with the paid layers absent, not disabled. Reports are JSON definitions, so a report built here imports into a Cloud workspace unchanged (**Reports → Import**); lake tables move as CSV.

## What's in the box

- **Report designer** — 18 block types (KPI, table, bar, line, area, pie, waterfall, gauge, map, heatmap and more), themes, parameters, multi-page reports, version history.
- **Data** — connect Postgres, MySQL, SQLite or a REST API; or drop a CSV / XLSX / JSON into the built-in lake with typed ingestion. Parameters are bound, never concatenated; DDL and DML are blocked.
- **Exports** — PDF (Chromium), XLSX, DOCX and CSV rendered from the same tree as the viewer.
- **Delivery** — scheduled email of any report, on a cron you choose.
- **Trust** — a provenance hash on every cell; hover to see query hash, data hash, run time and row count.
- **Templates** — nine industry starter reports. Sign-in with credentials or Google / GitHub. English, Thai and Chinese.

Master Builder, Ask Curf, watchers, Operate, Analytic Apps, the MCP server and the warehouse connectors are part of [Curf Cloud](https://curf.ai/pricing/).

## Run it

Curf runs on Postgres. The repo ships a `docker-compose.yml` that starts one on port 5432.

```bash
git clone https://github.com/EnterpriseX-Platform/CurfAI.git curf
cd curf
cp .env.example .env     # DATABASE_URL already points at the compose Postgres
docker compose up -d     # Postgres 16
npm install              # runs prisma generate
npx prisma migrate deploy
npm run db:seed
npm run dev              # http://localhost:3100
```

Sign in with `admin@curf.local` / `admin123`, open **Reports**, and start from a template.

For production, point `DATABASE_URL` at your own Postgres and run `npx prisma migrate deploy` on every deploy; each release adds its migration under `prisma/migrations`. `DEPLOY.md` has Docker, Kubernetes, Fly and Railway recipes; the `Dockerfile` builds a single image with Chromium for PDF export.

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `NEXTAUTH_URL` | yes | The URL you serve the app at |
| `NEXTAUTH_SECRET` | yes | Session signing key |
| `CRON_SECRET` | yes | Protects `POST /api/cron/tick`, which runs scheduled deliveries |
| `SMTP_*` | for email schedules | SMTP host, port, user, password, from |
| `ANTHROPIC_API_KEY` | optional | Enables "Generate a report from a prompt" (or paste a key per workspace under Admin → Tenant → LLM) |
| `GOOGLE_*` / `GITHUB_*` | optional | Sign in with Google or GitHub |

Call `POST /api/cron/tick` with the `x-cron-secret` header every minute from any scheduler; it is idempotent.

## Contributing

Bug reports and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) — every commit needs a DCO sign-off (`git commit -s`). Security issues go to the address in [SECURITY.md](SECURITY.md), not the issue tracker.

This repository is published from Curf's private source tree on every release; see `EXPORT.txt` for the version and the commit it came from. `CHANGELOG.md` covers all of Curf, so entries about Master Builder, Ask Curf, watchers, Operate or apps describe Curf Cloud. Pull requests are reviewed here and applied upstream, and land in the next release with your attribution.

## License

MIT. See [LICENSE](LICENSE). "Curf" and the Curf mark are trademarks of EnterpriseX Platform; the licence covers the code, not the brand.
