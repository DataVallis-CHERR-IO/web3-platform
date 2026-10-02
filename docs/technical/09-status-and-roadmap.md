# CHERR.IO — Status and roadmap

This page lists every Phase 1 task, what has actually been delivered, and what is still planned. "Done" is taken only from the task feedback files (`docs/tasks/*.feedback.md`), which contain the test results; where the feedback says PARTIAL, the task is shown as *In progress* even if the task index says otherwise. In short: the foundation is finished — monorepo and CI, all smart contracts (tested and deployed to the Amoy testnet for dev), the database schema, the server and deployment pipeline, the design system and Privy login (live on https://dev.cherr.io). The indexer is written and tested but not yet running on the server. Everything a donor or charity would actually use — onboarding, campaigns, donations, card payments, voting UI, Emergency Pool UI, Charity Market Cap, public API — is still in the backlog. Nothing runs on Polygon mainnet and no real money is involved.

Last updated: 2026-10-01

Sources: docs/tasks/README.md; docs/tasks/*.feedback.md; docs/CHEATSHEET.md

---

## 1. What is live on the dev environment today

"Live on dev" means running on https://dev.cherr.io (protected from search engines, auto-deployed on push to the `dev` branch) or deployed to the Polygon **Amoy testnet** for the dev environment. No real funds.

| Item | Details | Source |
|---|---|---|
| Web app | Landing page (built from the design-system mockup, with **sample/fixture data**, not real campaigns); header/footer, light/dark theme; "coming soon" pages for Campaigns, Charity Market Cap, Emergency Pool, How it works, About, Docs; component gallery `/en/dev/ui` (dev only) | TASK-007.feedback.md, TASK-025.feedback.md, CHEATSHEET §1 |
| Login | Privy: email, Google, external wallet (e.g. MetaMask); embedded wallet created at login for users without one; server session cookie; account page (display name, anonymous-donation flag, linked wallets, **delete my account** = GDPR erasure) | TASK-025.feedback.md, ADR-024 |
| Admin | `PLATFORM_ADMIN` role in the database; `/en/admin` is a placeholder (404 for everyone else). Admins are granted with a CLI script. | TASK-025.feedback.md, CHEATSHEET §1 |
| Health check | `/api/health` checks auth configuration and runs `select 1` through PgBouncer; a failing check keeps the previous container | CHEATSHEET §1 |
| Database | Postgres 16 + pgvector, schema `app` (18 tables) migrated on dev by the deploy pipeline | TASK-005.feedback.md, TASK-022.feedback.md, tasks/README.md carry-overs |
| Smart contracts (amoy-dev) | PlatformConfig, Campaign implementation, CampaignFactory, EmergencyPool, TimelockController (5-minute delay), deployed 2026-10-01 and verified on Polygonscan. All roles held by one testnet wallet (ADR-025). Addresses: `packages/contracts/deployments/amoy-dev.json`. The web app does **not** yet call them. | DEPLOY-AMOY.feedback.md, CHEATSHEET §7, ADR-025 |
| Server and pipeline | One Hetzner CX33 VPS; shared Postgres (3 databases), PgBouncer, Prometheus/Grafana/Loki; Kamal 2 deploys from GitHub Actions; images built in CI only; firewall allows only 22/80/443 (UFW; Hetzner Cloud Firewall still to be confirmed) | TASK-024.feedback.md, TASK-022.feedback.md, CHEATSHEET §2, §9 |
| Backups | Hetzner daily whole-server snapshot; daily encrypted (age) off-site `pg_dump` of the **prod** database and weekly (Sunday) of **uat**; the dev database is not dumped off-site (see contradictions below). One restore drill done on 2026-09-29 with an empty database. | TASK-024.feedback.md, infra/backups/backup.sh, ADR-023 |

**Not live anywhere:** uat environment, production (`cherr.io`), Polygon mainnet contracts, the indexer, the worker, any donation/campaign/payout flow.

---

## 2. What exists only as code (built, tested, not running)

| Item | Status | Source |
|---|---|---|
| Ponder indexer (all 23 contract events, reconcile tool, prune tool) | Merged (PR #15, #16). Tested locally against a local chain. Not deployed to the server; the dev-deploy configuration (TASK-026) is written but the server steps have not been run. | TASK-006.feedback.md, TASK-026.feedback.md, CHEATSHEET §9 |
| Indexer dev deploy (Docker image, Kamal service, DB role with no access to `app`, deploy job) | Proven locally; NOT RUN on the server or in GitHub Actions. | TASK-026.feedback.md |
| Mainnet deploy script `DeployPolygon.s.sol` | Enforces the 48 h timelock and a real Safe; tested in Foundry; never run. | DEPLOY-AMOY.feedback.md |
| Off-chain helpers: GDPR `eraseUser`, seed data (5 sub-pools, 3 imported orgs) | In code; `eraseUser` is used by the live account-deletion endpoint. | TASK-005.feedback.md, TASK-025.feedback.md |
| Worker (`apps/worker`) | Only a "health" queue; no business jobs. | TASK-001.feedback.md, apps/worker/src/ |
| MCP server (`apps/mcp`) | Empty placeholder package. | TASK-001.feedback.md |

---

## 3. Task table

Order of work (from the task index, updated 2026-10-01): 001 → 024 → 002 → 003 → 004 → 005 → 007 → 022 → DEPLOY-AMOY → 025 → 006 → 008 → 010 → 011 → …

| ID | Title | Status | What it delivered (from feedback) | Still planned / open |
|---|---|---|---|---|
| TASK-001 | Monorepo scaffold, tooling, CI, local dev stack | **Done** | Turborepo + pnpm monorepo (Node 22); shared configs; Foundry project; `packages/shared` (USDC money math with bigint, chain config); Drizzle setup; Next.js 15 + Tailwind v4 + next-intl; Ponder and BullMQ placeholders; CI (lint, typecheck, tests, forge, build) and promotion-guard workflow. | – |
| TASK-002 | Contracts: PlatformConfig, CampaignFactory, Campaign (donate, finalize, refunds, SINGLE payout) | **Done** | Role-based config with bounded parameters; deterministic clone factory (min target 100 USDC, deadline 1–90 days); escrow with clipping, 10% threshold, SINGLE release, pull refunds, settle-to-pool, 180-day sweep; ABI export. 120 tests incl. fuzz and 7 invariants; 100% line coverage on contracts. | – |
| TASK-003 | Contracts: milestones, voting, Guardian freeze/resolve | **Done** (feedback: "Implementation complete, all tests passing") | 3-tranche payout; donation-weighted voting (50% quorum / 51% approval); NEEDS_REVIEW and REJECTED paths; Guardian freeze/resolve; pro-rata refunds after rejection; 72 h release delay for SINGLE; USDC-blacklist recovery path. 170 tests; 100% line/function coverage. | – |
| TASK-004 | Contracts: EmergencyPool + sub-pools + allocation votes; Timelock deploy scripts | **Done** | EmergencyPool with sub-pools, checkpointed contributor voting (anti vote-buying), allocations to live campaigns, reclaim from failed campaigns; Amoy and Polygon deploy scripts (Timelock as admin, deployer renounces). 234 tests; Slither: 0 high, 4 medium (explained as false positives / by design). | Deployment done later in DEPLOY-AMOY. |
| DEPLOY-AMOY *(not in index table)* | Deploy contracts to Amoy for dev | **Done** | Configurable timelock delay on Amoy (5 min), 48 h hard-coded on mainnet, Safe must be a contract on mainnet; deployment JSON written only on real broadcast; `amoy-dev` addresses wired into `packages/shared`. 241 Foundry tests. Deployed 2026-10-01. | amoy-uat deployment at first dev → uat promotion. |
| TASK-005 ‖ | DB package: Drizzle schema, migrations, seed | **Done** | 18 tables / 17 enums in schema `app`; bigint-safe USDC columns; check constraints; idempotent migrations and seed; GDPR `eraseUser`. 11 integration tests (14 after TASK-025). | – |
| TASK-024 ‖ | Server provisioning, hardening, shared infra, backups, Kamal skeleton | **Done** | Idempotent provisioning; SSH hardening (no root, keys only); UFW + fail2ban; shared Postgres/PgBouncer/monitoring stack with memory limits, no public DB ports; encrypted off-site backups with restore script; first restore drill (empty DB). | Hetzner Cloud Firewall confirmation; restore drill with real tables; Promtail → Alloy; narrower sudo for `deploy` user. |
| TASK-006 | Ponder indexer for all contracts | **In progress** (feedback: PARTIAL; index: "Next") | All 13 indexer tables, handlers for 23 events (Campaign, Factory, EmergencyPool); reconcile against the contracts; scenario test on a local chain (0 mismatches); CI job "Indexer scenario". | CI job proven green on GitHub; indexing real Amoy; Prometheus scrape of metrics. |
| TASK-026 *(not in index table)* | Indexer deploy (dev) | **In progress** (feedback: PARTIAL) | Indexer Docker image, separate Kamal service (no public port, 384 MB), DB role with no access to `app`, connection budget, deploy job (deploy → wait ready → reconcile → prune), own prune script. Proven locally only. | David's server steps, first and second deploy on dev, real-Amoy memory/backfill figures; uat/prod configs. |
| TASK-007 | Web shell + design system in code | **Done** | Design tokens → Tailwind; 11 design-system components; restyled shadcn/ui; app shell; landing page per mockup; `/dev/ui` gallery; Playwright + axe accessibility tests (20 passing). | – |
| TASK-022 | App deploys (deploy.yml, GHCR, Environments, migrations, smoke tests, rollback) | **Done** (feedback: "DONE, awaiting David's server setup"; index: dev live) | Standalone Next.js Docker image; deploy workflow (build → Kamal deploy → migrate → smoke tests); dynamic robots.txt / noindex on non-prod; rollback procedure. dev live at dev.cherr.io. | Prod deploy is manual until launch; migrations run after the new container takes traffic (to revisit). |
| TASK-025 | Auth: Privy login, app session, account page, roles, coming-soon pages | **Done** (live on dev 2026-10-01) | Privy login (email, Google, wallet); signed httpOnly session cookie; DB-checked admin role; account page with GDPR deletion; wallet sync verified server-side; origin check and rate limiting; coming-soon pages; `grant-admin` script. 36 web unit tests, 14 DB integration tests, 86 E2E/a11y tests. | Smart accounts + gas sponsorship (TASK-011); separate Privy app for prod; admin MFA. |
| TASK-008 | Organization onboarding + manual KYB admin flow + private uploads | **Backlog** | – | Org registration, KYB review by admins, encrypted private document storage. |
| TASK-009 | Individual onboarding with Sumsub KYC | **Backlog** | – | Sumsub KYC flow and webhooks (no ID documents stored). |
| TASK-010 | Campaign creation, review, EUR→USDC snapshot, on-chain deployment via Safe/operator | **Backlog** | – | Drafts, admin review, rate snapshot, creating campaign contracts. |
| TASK-011 | Campaign pages + donation flow (wallet, sponsored smart account) | **Backlog** | – | Donating from a wallet; gasless donations via ERC-4337 + Alchemy Gas Manager. |
| TASK-012 | Transak card onramp + "finish your donation" flow | **Backlog** | – | Card → USDC to donor's own wallet → donate. |
| TASK-013 | Payout, evidence submission, voting UI, refunds/pool claims | **Backlog** | – | UI for release, evidence, voting, refunds. |
| TASK-014 | Emergency Pool UI + allocation votes | **Backlog** | – | Pool pages, direct donations, allocation voting. |
| TASK-015 | Ratings + Proof of Charity ledger + levels job | **Backlog** | – | Ratings, points, monthly levels. |
| TASK-016 | Registry importers (SI, UK, US) | **Backlog** | – | Import public charity registries. |
| TASK-017 | Trust Score v1 job + Charity Market Cap pages + methodology | **Backlog** | – | Public ranking and methodology page. |
| TASK-018 | Public REST API + OpenAPI, llms.txt, JSON-LD, sitemap | **Backlog** | – | Read-only public API. |
| TASK-019 | Embeddable donate widget (web component) | **Backlog** | – | Widget for partner websites. |
| TASK-020 | Read-only MCP server | **Backlog** | – | MCP access to public data. |
| TASK-021 | Admin panel consolidation + audit log | **Backlog** | – | Full admin panel. |
| TASK-023 | Audit preparation, Slither, docs; mainnet deployment runbook | **Backlog** | – | External audit preparation, Slither in CI, mainnet runbook; off-site backups + restore drill before mainnet (ADR-023); Polygon finality review for the indexer. |

Not on the Phase 1 list (Phase 2+): CHR activation and locking, 4% reward distribution, points → CHR conversion (needs a MiCA legal opinion, ADR-019), social-action points, community vetting of individual campaigns, sponsored listings, document search.

Sources: docs/tasks/README.md; docs/tasks/TASK-001.feedback.md; docs/tasks/TASK-002.feedback.md; docs/tasks/TASK-003.feedback.md; docs/tasks/TASK-004.feedback.md; docs/tasks/DEPLOY-AMOY.feedback.md; docs/tasks/TASK-005.feedback.md; docs/tasks/TASK-006.feedback.md; docs/tasks/TASK-007.feedback.md; docs/tasks/TASK-022.feedback.md; docs/tasks/TASK-024.feedback.md; docs/tasks/TASK-025.feedback.md; docs/tasks/TASK-026.feedback.md; docs/01-PRODUCT-SPEC.md §6; docs/03-DECISIONS.md

---

## 4. Open items and carry-overs

- Restore drill with real tables (dev now has the `app` schema).
- Confirm the Hetzner Cloud Firewall is applied (UFW is active in the meantime).
- Migrations currently run after the new container takes traffic; the expand/contract migration rule is mandatory until this is revisited.
- Deploy amoy-uat contracts at the first dev → uat promotion.
- Indexer: first deploy to dev; uat/prod indexer configs and secrets.
- Separate Privy app for prod before launch.
- Before mainnet (TASK-023): external smart-contract audit (budget line required), Slither + invariant tests in CI, mainnet runbook, off-site backup restore drill, bug bounty after mainnet.

Sources: docs/tasks/README.md (Carry-overs); docs/CHEATSHEET.md §9; docs/02-ARCHITECTURE.md §6; docs/03-DECISIONS.md (ADR-023)

---

## 5. Where the documents disagree (for the team to fix)

| Topic | Disagreement | Files |
|---|---|---|
| TASK-006 status | Index says "Next"; feedback says PARTIAL with both PRs merged. | docs/tasks/README.md; docs/tasks/TASK-006.feedback.md |
| TASK-004 status | Index says "Done (not deployed)"; contracts were since deployed to amoy-dev. | docs/tasks/README.md; docs/tasks/DEPLOY-AMOY.feedback.md; docs/CHEATSHEET.md §7 |
| TASK-026 | Has a task file and feedback but no row in the task index. | docs/tasks/README.md; docs/tasks/TASK-026.feedback.md |
| Off-site DB backups | Cheat sheet: daily dump of all 3 databases. Backup script and TASK-024: prod daily, uat Sundays only, dev never. ADR-023 says off-site dumps are to be installed before mainnet, but they already run. | docs/CHEATSHEET.md §5; infra/backups/backup.sh; docs/tasks/TASK-024.feedback.md; docs/03-DECISIONS.md (ADR-023); docs/02-ARCHITECTURE.md §5.4 |

Sources: as listed in the table.
