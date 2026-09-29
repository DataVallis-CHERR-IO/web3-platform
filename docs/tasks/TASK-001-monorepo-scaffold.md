# TASK-001 — Monorepo scaffold, tooling, CI, local dev stack

Read first: `docs/00-MANIFEST.md`, `docs/02-ARCHITECTURE.md` §1, §5.

## Goal
An empty but fully wired monorepo where every app/package builds, lints, typechecks and tests, and the local infra runs with one command.

## Scope
1. **Turborepo + pnpm** workspace at repo root. Node 22 (`.nvmrc`, `engines`). `turbo.json` pipelines: `build`, `dev`, `lint`, `typecheck`, `test`, `clean`.
2. Create packages/apps from Manifest §5 with minimal content:
   - `apps/web`: Next.js (App Router, TS strict, Tailwind, shadcn/ui init). **next-intl** configured with `[locale]` segment, `en` only, messages in `apps/web/messages/en.json`, middleware redirecting `/` → `/en`. One page `/[locale]` rendering a translated "CHERR.IO — coming soon" heading. Brand color tokens as CSS variables placeholders (`--cherry-red`, etc. with TODO comment referencing brand PDF).
   - `apps/indexer`: Ponder init placeholder (no contracts yet) that starts without error.
   - `apps/worker`: TS Node app with BullMQ, one `health` queue + a sample job and a Vitest test.
   - `apps/mcp`: empty TS package with README "Phase 1 late".
   - `packages/contracts`: `forge init` style Foundry project (no template contracts left), `foundry.toml` with `solc = 0.8.24`, optimizer on, fuzz runs 1000, `remappings` for OpenZeppelin v5 (install via forge). Add `pnpm` scripts wrapping `forge build/test/fmt`.
   - `packages/db`: Drizzle + `postgres` driver, `drizzle.config.ts`, empty schema file, `migrate` script.
   - `packages/shared`: exports `chains.ts` (Polygon, Amoy with USDC addresses from architecture §2.4) and a `money.ts` with `parseUsdc(string): bigint` / `formatUsdc(bigint): string` (6 decimals) + Vitest tests including edge cases.
   - `packages/ui`: shadcn/ui components package consumed by `apps/web` (Button only for now).
   - `packages/config`: shared ESLint (flat config), Prettier, tsconfig bases.
3. **Local infra**: `docker-compose.dev.yml` with Postgres 16 + pgvector (`pgvector/pgvector:pg16`), Redis 7. Root script `pnpm dev:infra`. `.env.example` at root and per app with placeholders only.
4. **CI** (Architecture §5.2–5.3):
   - `.github/workflows/ci.yml` — on `pull_request` into `dev`, `uat`, `main` and on `push` to any branch: pnpm install (cache), lint, typecheck, test (TS), `forge test` (Foundry via `foundry-rs/foundry-toolchain`), build. Concurrency: cancel in-progress runs for the same ref.
   - `.github/workflows/promotion-guard.yml` — on PR into `uat`: fail unless head branch is `dev`; into `main`: fail unless head is `uat` or starts with `hotfix/`.
   - **No deploy workflow yet** (TASK-022).
   - `packages/shared/src/env.ts`: `APP_ENV` = `local | dev | uat | prod` (zod-validated) and `getChainConfig(appEnv)` → local = Anvil 31337, dev/uat = Amoy 80002, prod = Polygon 137, each with its USDC address. Contract addresses are loaded from `packages/contracts/deployments/<name>.json` when present (`amoy-dev`, `amoy-uat`, `polygon`), otherwise `undefined` — never hard-coded.
   - `docs/`-independent `CONTRIBUTING.md` at root: branch naming, PR flow `feat/* → dev → uat → main`, hotfix flow.
5. Root `README.md`: prerequisites, setup, commands table. Keep `docs/` untouched.
6. `.gitignore`, `.editorconfig`, commitlint **not** required.

## Must not touch
`docs/**` (except creating your feedback file).

## Allowed dependencies
turbo, next, react, react-dom, tailwindcss, shadcn/ui deps, next-intl, @ponder/core (or `ponder`), bullmq, ioredis, drizzle-orm, drizzle-kit, postgres, vitest, eslint, prettier, typescript, zod, viem.

## Acceptance criteria
- `pnpm install && pnpm build && pnpm lint && pnpm typecheck && pnpm test` pass from clean clone.
- `pnpm dev:infra` starts Postgres (with `CREATE EXTENSION vector` working) and Redis.
- `pnpm --filter web dev` serves `/en` with the translated heading; `/` redirects to `/en`.
- `pnpm --filter contracts test` runs (zero tests is OK but command must succeed).
- CI and promotion-guard workflows are valid YAML (checked with `actionlint`) and would run all of the above.
- `getChainConfig` has Vitest tests for all four `APP_ENV` values.
- Work is on branch `feat/TASK-001-monorepo-scaffold` (David creates the PR to `dev`).
- No hard-coded UI strings in `apps/web`.

## Feedback
Write `docs/tasks/TASK-001.feedback.md` per Manifest §9.
