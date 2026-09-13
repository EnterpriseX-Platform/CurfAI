# Contributing to Curf Community

Thanks for helping. Two things make a contribution easy to accept.

## 1. Sign your commits (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/). By signing off you certify that you wrote the change or have the right to submit it under the MIT licence, and that we may include it in Curf, including the paid editions. Sign off with:

```bash
git commit -s -m "fix(designer): keep the column picker open after a rename"
```

That adds `Signed-off-by: Your Name <you@example.com>` to the commit. Every commit in a pull request needs it; a bot checks.

## 2. Keep a change reviewable

- **One change per pull request.** A bug fix and an unrelated refactor are two PRs.
- **Say what and why** in the description, and how you tested it. A screenshot for anything visible.
- **Tests** — add or update a unit test next to the code (`*.test.ts`, Vitest) for behaviour you changed. `npm test` must pass.
- **Lint and types** — `npm run lint` and `npx tsc --noEmit` must be clean.
- **Security first** — every Prisma query is workspace-scoped (`tenantWhere`), every user-supplied URL goes through the SSRF guard, every SQL field through the SQL guard. A PR that weakens any of these will be asked to change.
- **Don't fork rendering.** `ReportDocument.tsx` drives the viewer, designer and PDF. Fix rendering there, once.

## How changes land

This repository is a snapshot of Curf's private source tree, published on every release. Maintainers review your PR here, apply it upstream, and it appears in the next release commit with your `Signed-off-by` and a mention in `CHANGELOG.md`. Your PR is then closed with a link to that release.

## Where to ask

- **Bugs and features** — open an issue with the template.
- **Security** — see [SECURITY.md](SECURITY.md). Never open a public issue for a vulnerability.
- **Everything else** — hello@curf.ai.
