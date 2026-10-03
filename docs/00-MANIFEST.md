# CHERR.IO — Agent Manifest (v2)

> This file is the operating contract for any AI coding agent (Claude Code) working in this repository.
> Read it fully before every task. If anything in a task file contradicts this manifest, **stop and report** instead of guessing.

## 1. What we are building

CHERR.IO is a transparent charitable-donation platform on **Polygon**. Donors give **USDC**; funds sit in a per-campaign smart-contract escrow and are released to the beneficiary either at once or in **three milestone tranches approved by donor vote**. A public **Charity Market Cap** ranks organizations by a published trust score. The community earns **Proof of Charity** points; the **CHR** token (existing ERC-20) is used for campaign activation and locking in Phase 2.

Source-of-truth order when documents disagree:
1. `docs/03-DECISIONS.md` (ADRs — newest wins)
2. `docs/01-PRODUCT-SPEC.md`
3. `docs/02-ARCHITECTURE.md`
4. The task file you were given
5. The 2018 whitepaper (historical reference only — never implement from it directly)

## 2. Roles

| Role | Who | Responsibility |
|---|---|---|
| Product owner / engineer | David (Data Vallis d.o.o.) | Decisions, commits, deployments, key custody |
| CTO | Claude | Writes specs and tasks, reviews agent output against scope |
| Implementer | Claude Code (CLI, in the repo) | Implements exactly one task at a time, reports back |

**The agent never commits, pushes, merges, deploys, or touches keys/secrets.** David commits.

## 3. How a task works

1. You receive `docs/tasks/TASK-XXX-*.md`. Implement **only** what is in its *Scope*.
2. Do not modify files listed under *Must not touch*. Do not add dependencies not listed, unless you justify it in feedback.
3. When done, write `docs/tasks/TASK-XXX.feedback.md` using the template in §9. Do not mark anything done that is not tested.
4. If blocked or the task is ambiguous: write the feedback file with status `BLOCKED` and your questions. Do not invent business rules.

### Git and environments
- Each task is done on its own branch: `feat/TASK-XXX-<short-name>` created from `dev`. Fixes: `fix/<short>`.
- The PR goes to `dev`. Promotion `dev → uat → main (prod)` is done only by David via PRs.
- Environments: **dev** and **uat** run on Polygon Amoy, **prod** (`main`) on Polygon mainnet — see Architecture §5.1–5.3.
- Never hard-code environment values (URLs, chain IDs, contract addresses). Read them from env config; `packages/shared` resolves chain + addresses by `APP_ENV` (`local|dev|uat|prod`).
- Any DB migration must be backward compatible with the previously deployed code.

### Server access (`ssh deploy@49.13.63.71`; `root` only during initial provisioning)
- All server configuration is **code in `infra/`** (scripts, compose files, configs). Never make a manual change on the server that is not in the repo.
- Scripts must be **idempotent** (safe to run twice) and support `--dry-run`.
- Read-only diagnostics over SSH (`docker ps`, `df -h`, `free -m`, logs) are allowed.
- **Ask David before running** anything that changes the server: installs, firewall, sshd, users, deleting volumes/containers/images, restarting shared infra (Postgres!). Show the exact command first.
- **Never** delete or reset `cherrio_prod`, never publish DB/Redis ports, never copy private keys or secrets into the repo or chat.
- When changing SSH config: keep the current session open and verify a new login works before closing it.

## 4. Stack (fixed — do not substitute)

| Area | Choice |
|---|---|
| Repo | Turborepo + **pnpm** workspaces, Node **22 LTS**, TypeScript **strict** |
| Web | Next.js (App Router, RSC/SSR), Tailwind CSS, shadcn/ui |
| i18n | **next-intl**, locale-prefixed routes (`/en/...`). English only at launch. **No hard-coded UI strings.** |
| Web3 client | wagmi + viem; external wallets connect through Privy (ADR-024) |
| Auth | **Privy** for all login methods: email/social → embedded wallet + ERC-4337 smart account, and external wallets (Privy performs SIWE). Own signed, httpOnly app session cookie, 7 days; roles re-read from the DB (ADR-024, ADR-028) |
| Gas sponsorship | Alchemy Gas Manager (paymaster) for smart accounts |
| Card onramp | **Transak** widget → USDC on Polygon to the donor's own wallet |
| KYC (individuals) | **Sumsub** Web SDK + webhooks. We never store ID documents. |
| KYB (organizations) | Manual review by platform admins |
| Contracts | Solidity ^0.8.24, **Foundry** (unit + fuzz + invariant tests), OpenZeppelin v5 |
| Chain | Polygon PoS — **Amoy** testnet for development, mainnet later |
| RPC | Alchemy |
| DB | PostgreSQL 16 + **pgvector**, **Drizzle ORM**, PgBouncer |
| Indexer | **Ponder** |
| Jobs | Redis + **BullMQ** (`apps/worker`) |
| Public files | PollinationX (primary), Pinata (fallback) — **only non-personal content** |
| Private files | Hetzner Object Storage (S3 API), server-side encryption, hash anchored on-chain |
| Infra | Hetzner VPS, Docker, **Kamal 2 + kamal-proxy** (no Traefik), Prometheus + Grafana + Loki, nightly `pg_dump` off-site |
| Tests | Vitest (TS), Playwright (E2E), Foundry (contracts) |

### Design system
- UI follows the **CHERR.IO Design System** (ADR-022): https://claude.ai/artifact/Fu6XZBiPYfpavViQcubit4 — tokens, component specs and usage rules. David exports it into `packages/ui/design-system/` (tokens.json, README.md, bundle.css, component READMEs) so it lives in the repo; that folder is the source for Tailwind theme tokens and shadcn/ui overrides.
- Never introduce colours, radii, shadows or fonts that are not tokens. shadcn/ui components are restyled to the system (radius 0, 3px borders), not used with their defaults.

## 5. Repository layout

```
apps/
  web/         Next.js app (UI, route handlers = public REST API, admin panel)
  indexer/     Ponder — chain events → Postgres
  worker/      BullMQ workers (registry import, trust score, notifications, KYC webhooks)
  mcp/         MCP server (Phase 1, late)
packages/
  contracts/   Foundry project; exports ABIs + addresses
  db/          Drizzle schema, migrations, seed
  shared/      zod schemas, domain types, constants, chain config
  ui/          shadcn/ui components
  config/      eslint, tsconfig, prettier presets
docs/          specs, decisions, tasks, feedback
```

## 6. Non-negotiable rules

- **Money is USDC with 6 decimals.** Use `bigint` everywhere in TS for token amounts. Never `number`, never floats.
- **EUR is display/target only.** On-chain logic works in USDC units only.
- **No personal data on-chain or on IPFS/PollinationX.** Invoices, medical records and IDs go to private storage; only their SHA-256 hash goes on-chain.
- **All user-facing text through next-intl message files.**
- **Every contract state change emits an event**; the indexer, not the web app, is the source for on-chain state in the DB.
- **Access control via OpenZeppelin `AccessControl`**, roles defined in §2 of the architecture doc. No `onlyOwner` shortcuts.
- **No secrets in the repo.** Use `.env.example` with placeholders. Private keys never live in `.env` on the server.
- **Contract changes require tests**: unit tests for every function, fuzz tests for all amount math, invariant tests for escrow balance conservation.
- Conventional Commits style for suggested commit messages in feedback.
- **AI-generated code is marked** (`AI-USE.md`): every commit with generated code carries the model trailer `Co-Authored-By: Claude <model> <noreply@anthropic.com>` and a `Prompt:` line in the body pointing to the task spec used as the prompt (`Prompt: docs/tasks/TASK-XXX-….md`) or, for ad-hoc work, a one-line summary of the instruction.
- Keep PR-sized scope: if a task is growing beyond ~800 changed lines, stop and report.

## 7. Out of scope unless a task says otherwise

CHR activation/locking, points-to-CHR conversion, social-network point verification, ML staking suggestions, NFTs, white-label, metaverse, pgvector RAG, mobile apps.

## 8. Domain glossary

- **Campaign** — fundraising with a EUR target converted to a USDC target at approval, and a deadline.
- **Beneficiary** — the verified organization or the verified individual (Cherrion) receiving funds.
- **Cherrion** — any registered user.
- **Success threshold** — 10% of target. Below it at deadline the campaign fails.
- **Payout mode** — `SINGLE` (org rating ≥ 4.0 or first campaign under supervision) or `MILESTONES` (3 equal tranches).
- **Emergency Pool** — a contract holding funds from failed/rejected campaigns (by donor choice) plus direct donations; has thematic sub-pools.
- **Trust Score** — public, versioned 0–100 score shown on Charity Market Cap.

## 9. Feedback template (`docs/tasks/TASK-XXX.feedback.md`)

```markdown
# TASK-XXX feedback
Status: DONE | PARTIAL | BLOCKED

## What I implemented
- ...

## Files changed
- path — why

## Deviations from the task (and why)
- none | ...

## New dependencies
- package@version — why

## How to verify
1. command...
2. expected result...

## Test results
- paste summary (counts, coverage for contracts)

## Open questions / risks
- ...

## Suggested commit message
feat(scope): ...
```
