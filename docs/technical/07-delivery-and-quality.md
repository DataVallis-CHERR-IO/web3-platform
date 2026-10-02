# 07 — Delivery and quality

This document describes how CHERR.IO code moves from an idea to a running environment: the Turborepo monorepo and its tooling, the branch flow `feat/* → dev → uat → main`, the CI jobs that gate every change, the deploy pipeline (image built in CI → GHCR → Kamal → migrations → smoke tests, plus a separate indexer job), the test strategy with the latest reported test counts, and the AI-assisted engineering process in which a CTO agent writes specs, an implementer agent builds and proves the work with real outputs, and David (the owner) reviews and commits. It closes with the definition of done used for every task.

Last updated: 2026-10-02

Status legend: **Live** = in use today · **Built** = in the repo, not yet exercised on the target · **Planned** = specs/ADRs only.

---

## 1. Monorepo layout and tooling

```
apps/
  web/         Next.js App Router (UI, /api route handlers, admin)        — Live on dev
  indexer/     Ponder: chain events → Postgres (chain_<sha7> + chain views) — Live on dev
  worker/      BullMQ workers (health queue only today)                  — Built (scaffold)
  mcp/         MCP server placeholder ("Phase 1 late")                    — Planned
packages/
  contracts/   Foundry project; exports ABIs + deployment addresses
  db/          Drizzle schema (schema app), migrations, seed, grant-admin, GDPR erase
  shared/      zod schemas, env/chain config by APP_ENV, USDC money math (bigint)
  ui/          shadcn/ui components restyled to the design system; tokens → CSS
  config/      ESLint flat config, Prettier preset, tsconfig presets
docs/          manifest, product spec, architecture, ADRs, tasks + feedback, cheat sheet
infra/         provisioning, shared compose stack, backups (server as code)
config/        Kamal destinations (web + indexer)
```

| Tool | Version / setting | Source |
|---|---|---|
| Node | 22 LTS (`.nvmrc`, `engines.node >=22`) | `package.json`, `CLAUDE.md` |
| pnpm | 10.5.2 via Corepack (`packageManager`) | `package.json` |
| Turborepo | `turbo ^2.4.4`; tasks `build`, `dev`, `lint`, `typecheck`, `test`, `clean`, `tokens`, `check:design`, `test:e2e` | `package.json`, `turbo.json` |
| TypeScript | ^5.7, strict | `package.json`, `docs/00-MANIFEST.md` §4 |
| Lint / format | ESLint flat config (`@eslint/js`, `typescript-eslint`, `eslint-config-prettier`), Prettier | `docs/tasks/TASK-001.feedback.md` |
| Tests | Vitest (TS), Playwright + axe (E2E/a11y), Foundry (contracts) | `docs/00-MANIFEST.md` §4 |
| Contracts deps | `forge-std` and `openzeppelin-contracts` as git submodules pinned to release tags | `docs/tasks/TASK-001.feedback.md` |
| Local stack | `docker-compose.dev.yml`: Postgres 16 + pgvector on `127.0.0.1:5432`, Redis 7, s3mock on `127.0.0.1:9090` (`pnpm dev:infra`) | `CLAUDE.md`, `package.json` |
| Design guard | `pnpm check:design` (no non-token colours/fonts etc.) and token drift check in CI | `.github/workflows/ci.yml`, ADR-022 |

Rules that shape code review: money is USDC `bigint` with 6 decimals (never `number`); all UI strings via next-intl; no hard-coded env values; every contract state change emits an event; no secrets in the repo; PR-sized scope (stop and report beyond ~800 changed lines).

Sources: `docs/00-MANIFEST.md` §4–§6, `package.json`, `turbo.json`, `CLAUDE.md`, `AGENTS.md`, `docs/tasks/TASK-001.feedback.md`.

---

## 2. Branch flow

```
feat/TASK-xxx-*  ─PR─▶  dev  ─PR─▶  uat  ─PR─▶  main (prod)
fix/*            ─PR─▶  dev
hotfix/* (from main) ─PR─▶ main, then back-merge main → uat → dev
```

| Rule | Detail | Status |
|---|---|---|
| One branch per task | `feat/TASK-XXX-<short-name>` from `dev`; fixes `fix/<short>` | Live |
| Default branch | `dev` | Live |
| Promotion | Only David promotes `dev → uat → main` via PRs | Live (process) |
| Promotion guard | `promotion-guard.yml`: into `uat` only from `dev`; into `main` only from `uat` or `hotfix/*` | Live |
| Branch protection | PR required, CI green, no direct pushes, no force-push, merge commits (linear history off) | Described in architecture; GitHub setting not verifiable from repo |
| Auto-deploy | push to `dev` → dev, push to `uat` → uat; `main`/prod only by manual `workflow_dispatch` until launch | Live (dev) |
| Release tags | Created on prod deploy | Built |

Sources: `docs/02-ARCHITECTURE.md` §5.2, ADR-020, `.github/workflows/promotion-guard.yml`, `.github/workflows/deploy.yml`, `docs/00-MANIFEST.md` §3, `docs/CHEATSHEET.md` §6.

---

## 3. CI (`.github/workflows/ci.yml`)

Triggers: every push (any branch) and every PR into `dev`, `uat`, `main`. One run per ref; a newer push cancels the older run.

| Job | Steps | Notes |
|---|---|---|
| **Lint, Typecheck, Test & Build** (`typescript`) | Node 22 + pnpm via Corepack, cached store, `pnpm install --frozen-lockfile` → lint → typecheck (all except contracts) → Vitest for every package except `web` and `@cherrio/db` → **migrate test DB** → `web` tests (DB-backed) → `@cherrio/db` integration tests → build → generate design tokens + **fail on token drift** → design guard | Service containers `pgvector/pgvector:pg16` (`DATABASE_URL` and `DATABASE_URL_DIRECT` point at it) and `adobe/s3mock` on port 9090 (stand-in for private object storage; the `web` tests fail without it) |
| **E2E — a11y, no-Google-Fonts, organisation onboarding** (`e2e`) | Needs `typescript`. Install Playwright Chromium → build `web...` (without Solidity) → migrate the test DB → `pnpm test:e2e` → upload screenshots (14 days). The E2E server runs with **`APP_ENV=local`** (the origin check accepts a localhost origin only there; a unit test asserts that dev, uat and prod refuse it) | Playwright + axe accessibility checks; service containers `pgvector/pgvector:pg16` and `adobe/s3mock` for the logged-in tests |
| **Smart Contracts (Foundry)** (`contracts`) | Checkout with submodules → `forge fmt --check` → `forge build` → `forge test -vv` | Unit, fuzz and invariant suites |
| **Indexer scenario** (`indexer`) | Needs `typescript`. Foundry + Node → `pnpm --filter indexer test` (unit) → `pnpm --filter indexer test:scenario` | Anvil + `DeployAmoy.s.sol` + Ponder + Postgres; fails (never skips) if anvil, forge or the DB is missing; reconcile must report 0 mismatches |
| **Image build** (`images`, matrix `web` / `indexer`) | No `needs`. Buildx → `docker build` of `Dockerfile` and `Dockerfile.indexer` with `docker/build-push-action` (`push: false`) and the GitHub Actions cache (scopes `ci-web`, `ci-indexer`, separate from the deploy scopes). For `web` the image is loaded and `node apps/web/dist/files.mjs` must print its usage line, which proves the bundled script loads | Runs on every PR (no path filter) and on pushes to `dev`, `uat`, `main` — not on pushes to feature branches. **Built** (TASK-028): not run on GitHub yet |

The image build in CI exists because an image that cannot be built was once merged unnoticed (TASK-008b-2: a file outside the Docker build context was imported by a file that `next build` type-checks). Images are therefore not built on the laptop any more; CI builds both on every PR, and the deploy workflow builds and pushes them again from the merged commit.

Not in CI today: Slither static analysis (Planned, TASK-023).

Sources: `.github/workflows/ci.yml`, `docs/tasks/TASK-025.feedback.md` "Review round 3", `docs/tasks/TASK-026.feedback.md`, `docs/tasks/TASK-006.feedback.md`, `docs/02-ARCHITECTURE.md` §5.3, §6.

---

## 4. Deploy pipeline (`.github/workflows/deploy.yml`)

Triggers: push to `dev` or `uat`; `workflow_dispatch` with `environment` = `dev | uat | prod`. The GitHub Environment is chosen from the branch (`main` → `prod`) or the input. Concurrency group `deploy-<branch>`, never cancelled mid-run.

### 4.1 Web job — "Build → Deploy → Migrate" (Live on dev)

1. Compute tag `sha-<7 chars>`.
2. Build the `Dockerfile` image with Buildx (GHA cache), `NEXT_PUBLIC_GIT_SHA` build arg, push to `ghcr.io/datavallis-cherr-io/cherrio/web` using `GITHUB_TOKEN`.
3. Write `SSH_PRIVATE_KEY` and pinned `SSH_KNOWN_HOSTS`; install Ruby 3.3 and Kamal 2.12.0.
4. `kamal deploy -d <env> --skip-push --version sha-…` — pulls the image, uploads env files, boots the container, kamal-proxy health-checks `/api/health`, then switches traffic.
5. **Migrations after deploy**: `kamal app exec -d <env> --primary "node packages/db/dist/migrate.mjs"` (bundled with esbuild, uses `DATABASE_URL_DIRECT`). They run after the switch because Kamal uploads env files only during deploy; this is safe only because migrations must be backward compatible (expand → migrate → contract).
6. Smoke tests: `/api/health` must contain `"status":"ok"` and the deployed SHA; `/en` returns 200; `/en/dev/ui` returns 200 on dev and 404 elsewhere.
7. **Private file storage check** (**Built**, TASK-008a-2): `kamal app exec -d <env> --primary "node apps/web/dist/files.mjs check"`, only where the destination file configures `S3_BUCKET` (today: dev). See `05-infrastructure-and-environments.md` §4.3.
8. Prod only: create and push a release tag `v<YYYY.MM.DD>-<sha7>`.

### 4.2 Indexer jobs (Live on dev since 2026-10-01; first green run: GitHub Actions run 36923510353)

- **`indexer-changes`** decides whether to deploy: skipped if `config/indexer.<env>.yml` does not exist (uat, prod today); forced on `workflow_dispatch` (GitHub shows that button only once `deploy.yml` is on the default branch `main`, which it is not yet); otherwise only when `apps/indexer/`, `packages/contracts/`, `packages/shared/`, `pnpm-lock.yaml`, `Dockerfile.indexer`, `config/indexer*.yml` or `deploy.yml` changed.
- **`indexer`** — "Build → Deploy → Ready → Reconcile → Prune", independent of the web job (the web deploy never waits for a backfill):
  1. Build `Dockerfile.indexer` with `GIT_SHA7` (names schema `chain_<sha7>`), push to GHCR.
  2. `kamal deploy -c config/indexer.yml -d <env>` — no proxy; Kamal starts the new container, waits for Docker `HEALTHCHECK` (`/health`), then stops the old one.
  3. Wait for `/ready` (backfill reached the finalized block), polling every 10 s for up to 20 min; on timeout print the last 100 log lines and fail.
  4. `node dist/reconcile.mjs` — compares indexed rows with contract views; any mismatch fails the job.
  5. `node dist/prune.mjs` — keeps the schema the `chain` views read from plus the most recent other one (for rollback), drops older `chain_<sha7>`; never touches `app`, `chain`, `ponder_sync`.

### 4.3 Rollback

- Web: re-run the "Deploy" workflow of the last good commit, or `kamal rollback -d <env> sha-<good>`.
- Indexer: `kamal rollback -c config/indexer.yml -d <env> sha-<previous>`; the previous schema still exists, so it resumes from its checkpoint. Rolling back further than one version means a full re-index.

Sources: `.github/workflows/deploy.yml`, `config/deploy*.yml`, `config/indexer*.yml`, `Dockerfile`, `Dockerfile.indexer`, `docs/tasks/TASK-022.feedback.md`, `docs/tasks/TASK-026.feedback.md`, `docs/CHEATSHEET.md` §6, §10, ADR-026.

---

## 5. Test strategy and current counts

| Layer | What is tested | How |
|---|---|---|
| Contracts | Every function (unit), all amount math (fuzz), escrow balance conservation and state machine (invariant suites with handler counters), deploy scripts (Amoy EOA allowed, mainnet requires Safe contract and refuses timelock override) | Foundry; coverage reported ≥ 95–100 % lines on `src/` |
| Shared | USDC money math (`bigint`), env and chain config per `APP_ENV`, auth env validation | Vitest |
| DB | Migrations from zero, seed idempotency, `grantAdmin`, GDPR erase | Vitest integration against real Postgres |
| Web | Session sign/verify/expiry, origin check, IP extraction, rate limiter, auth API routes (Privy mocked), DB-backed session and role tests, dev-UI guard | Vitest; DB-backed suite **fails** if `DATABASE_URL` is unset or unreachable. Private files: unit tests (encryption, type check) and an integration suite over the real route handlers, Postgres and s3mock (upload is not stored as plaintext, audited admin download, 404 for non-admins, limits, delete, sweep, storage check) — it **fails** if s3mock is not reachable |
| E2E | Navigation and coming-soon pages, auth redirects, admin 404, login button on desktop/mobile, axe accessibility in light and dark themes, no Google Fonts, horizontal scroll. Logged in (test-only helper `apps/web/e2e/helpers/session.ts`: inserts a user and signs the app session cookie with the E2E server's secret; no Privy): organisation application with a PDF and a PNG upload, status page, axe on both | Playwright + axe; the logged-in tests need Postgres and s3mock |
| Indexer | Unit tests; scenario on Anvil with all allocation outcomes and reconcile (0 mismatches, deliberately corrupted row → 1 mismatch); prune safety; RPC key masking (real viem error, uncaught error, real `ponder start` and reconcile with a fake key) | Vitest + Anvil + Ponder + Postgres |

Latest reported counts (from feedback files; each is the most recent real run reported):

| Suite | Count | Source |
|---|---|---|
| Foundry (`forge test`) | 241 passed (incl. 21 deployment tests) | `docs/tasks/DEPLOY-AMOY.feedback.md` |
| `@cherrio/shared` (Vitest) | 50 passed | `docs/tasks/TASK-008b1.feedback.md` |
| `web` (Vitest, DB- and s3mock-backed) | 94 passed in 13 files | `docs/tasks/TASK-008c1.feedback.md` |
| `@cherrio/db` integration | 14 passed | `docs/tasks/TASK-025.feedback.md` round 3 |
| `worker` | 1 passed | `docs/tasks/TASK-025.feedback.md` round 3 |
| E2E (Playwright + axe) | 94 passed | `docs/tasks/TASK-008c2.feedback.md` |
| `indexer` unit | 15 passed in 3 files | `docs/tasks/TASK-026.feedback.md` |
| `indexer` scenario + prune | 18 passed (scenario 11, prune 7) | `docs/tasks/TASK-026.feedback.md` |

Proof that tests can fail is part of the evidence: e.g. stopping the DB makes the `web` suite exit 1; breaking prune planning fails 4 of 7 prune tests; corrupting a pool handler fails 3 of 11 scenario tests.

Sources: feedback files listed above, `docs/tasks/TASK-002.feedback.md`, `TASK-003.feedback.md`, `TASK-004.feedback.md`, `TASK-006.feedback.md`, `TASK-007.feedback.md`, `CLAUDE.md` "Hard rules", `docs/00-MANIFEST.md` §6.

---

## 6. AI-assisted engineering process

| Role | Who | Does |
|---|---|---|
| Product owner / engineer | David (Data Vallis d.o.o.) | Decides, creates branches, commits, pushes, merges, deploys, holds keys, applies server changes |
| CTO | Claude (CHERR.IO project chat) | Writes specs and task files, reviews the code in the files (not the summary) against scope |
| Implementer | Claude Code (CLI, in the repo) | Implements exactly one task at a time and reports back |

Flow per task (tasks run in order; each needs CTO review of its feedback before the next starts):

1. **CTO spec** — `docs/tasks/TASK-XXX-*.md` with goal, scope, must-not-touch list, tests and acceptance criteria; ADRs win over all other documents (newest wins).
2. **Implementer plan** — the agent reads manifest, ADRs, architecture, the task and feedback of dependencies, then replies with a plan (files, approach, tests, risks, questions) and **stops for approval**.
3. **Plan review** — the plan is approved or corrected.
4. **Implement** — only the approved scope; deviations are listed; new dependencies justified.
5. **Proof by real outputs** — test, build and command outputs produced in that session are pasted into `docs/tasks/TASK-XXX.feedback.md`; anything that could not run is written as `NOT RUN — <reason>`; guard tests are broken once to show they fail.
6. **Review** — the CTO reviews the files; findings come back as review rounds in the same feedback file (e.g. TASK-025 rounds 1 and 3; round 2 was deleted because it contained outputs that had not been produced).
7. **Owner commits** — David commits (suggested Conventional Commit message in the feedback), opens the PR to `dev`, performs any server step, and promotes.

Guardrails: hard rules in `CLAUDE.md`, deny rules in `.claude/settings.json` (no git writes, `ssh`, `kamal`, `sudo`, no reading `.env*` / `.kamal/secrets*`), one heavy job at a time on the laptop. See `06-security.md` §10.

Sources: `docs/00-MANIFEST.md` §2, §3, §9, `CLAUDE.md`, `.claude/settings.json`, `docs/tasks/README.md`, `docs/tasks/TASK-025.feedback.md`.

---

## 7. Definition of done

A task is **done** when all of the following hold:

- [ ] Only the task's *Scope* was implemented; *Must not touch* files are unchanged; deviations and new dependencies are listed with reasons.
- [ ] Every acceptance criterion is met with **real outputs** in `docs/tasks/TASK-XXX.feedback.md`; nothing untested is marked done; everything not run is listed as `NOT RUN`.
- [ ] Tests exist for the change and can fail (no silent skips, swallowed errors or early returns; missing DB/env fails the suite).
- [ ] Contract changes: unit tests for every function, fuzz tests for amount math, invariant tests for escrow conservation.
- [ ] `lint`, `typecheck`, unit/integration tests, build, design guard and (when UI changed) E2E + axe pass locally and CI is green.
- [ ] DB migrations are backward compatible with the previously deployed code.
- [ ] No secrets in code, logs or docs; no hard-coded env values; all UI text in next-intl; only design-system tokens.
- [ ] Change is PR-sized (≈ ≤ 800 changed lines) or the overrun was reported.
- [ ] Docs touched by the task (cheat sheet, infra README) are updated.
- [ ] CTO review passed; David has committed and merged. If the task needs server or GitHub steps, it stays **PARTIAL** until David has done them and pasted the outputs (example: TASK-026).

Sources: `docs/00-MANIFEST.md` §3, §6, §9, `CLAUDE.md`, `docs/tasks/TASK-026.feedback.md`, `docs/tasks/README.md`.
