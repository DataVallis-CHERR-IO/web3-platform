# TASK-046 feedback
Status: DONE (code, tests, docs) — on-chain creation of sub-pools 1–4 on Amoy-dev is David's step after the deploy

## What I implemented
- Migration `packages/db/drizzle/0012_seed_emergency_subpools.sql` (data only, generated with `drizzle-kit generate --custom`): the five sub-pool rows of `seed.ts`, `gen_random_uuid()` ids, `ON CONFLICT DO NOTHING`.
- `lib/admin/subpools.ts`: `loadSubpools` (rows ⨝ `chain.pool`, null without the views), `emergencyPoolAddress` (deployment; `LOCAL_EMERGENCY_POOL_ADDRESS` on local), `recordSubpoolSent` (audit `pool.subpool_create.sent`).
- `lib/admin/subpool-client.ts`: `sendCreateSubPool` (chain check → simulate through the reader → `writeContract` with Polygon fees) and `toSubpoolFailure` (`PoolAlreadyExists` → `already_done`, `NotOperator` → `not_operator`, rest via `toLifecycleFailure`).
- `POST /api/admin/emergency-pool/subpools/sent`.
- Page `/en/admin/emergency-pool` + client `SubpoolActions.tsx`; button "Emergency Pool sub-pools" on `/en/admin`.
- E2E fake admin wallet moved from `guardian.spec.ts` into `e2e/helpers/admin-wallet.ts` (shared, unchanged behaviour).

## Files changed
- packages/db/drizzle/0012_seed_emergency_subpools.sql, meta/0012_snapshot.json, meta/_journal.json — the migration
- packages/db/src/__tests__/integration.test.ts — rows exist without the seed
- apps/web/src/lib/admin/subpools.ts, apps/web/src/lib/admin/subpool-client.ts — server + browser logic
- apps/web/src/app/api/admin/emergency-pool/subpools/sent/route.ts — audit route
- apps/web/src/app/[locale]/admin/emergency-pool/page.tsx, SubpoolActions.tsx — admin page
- apps/web/src/app/[locale]/admin/page.tsx — link
- apps/web/messages/en.json — `admin.poolLink`, `admin.pool.*`
- apps/web/src/__tests__/admin-subpools.test.ts — Vitest
- apps/web/e2e/admin-emergency-pool.spec.ts, e2e/helpers/admin-wallet.ts, e2e/guardian.spec.ts — E2E
- apps/web/playwright.config.ts, playwright.env.ts — `LOCAL_EMERGENCY_POOL_ADDRESS` for the E2E server
- docs: this feedback, `runbooks/prod-launch.md` (Part D step 5), `TASK-046-emergency-subpools.md`, `tasks/README.md`, `technical/03`, `technical/04`, `technical/09`, owner guide v1.7 (+ README change log, PDF v1.7, v1.6 removed)

## Deviations from the task (and why)
- First screenshot at 390px: the long button labels ("Create “Medical emergencies” on the blockchain") overflowed the fixed-height buttons. Changed to one row per theme with a short visible label "Create on the blockchain"; the full text stays the accessible name.
- Admin link named "Emergency Pool sub-pools" (not "Emergency Pool") so it is not confused with the public header link of the same name.

## New dependencies
- none

## How to verify
1. `pnpm --filter @cherrio/db migrate` → `select pool_id, slug from app.emergency_subpools` lists 0 general … 4 climate.
2. On dev after the deploy: https://dev.cherr.io/en/admin → "Emergency Pool sub-pools" → General 0 "Yes", 1–4 "Not yet" → connect MetaMask 0x4326…B5a7 → "Create on the blockchain" next to each → after ~1 minute "Yes"; the donate panel's Emergency Pool choice then lists the themes.

## Test results
- `pnpm --filter @cherrio/db test:integration`: `Tests  17 passed (17)` (was 16).
- `pnpm --filter web test`: `Test Files  54 passed (54)`, `Tests  477 passed (477)` (was 471).
- `pnpm --filter='!@cherrio/contracts' lint` / `typecheck`: no errors; `pnpm check:design`: "Design check passed — no violations found."
- E2E (local build): `e2e/admin-emergency-pool.spec.ts` + `e2e/guardian.spec.ts`: first run `1 failed | 9 passed` (my locator matched the public header link "Emergency Pool" too → link renamed, locator scoped to `#main`); then `admin-emergency-pool.spec.ts` `4 passed (14.1s)`; guardian spec passed in the same first run (shared helper).
- Screenshots 1440 and 390 checked (temporary spec, not committed).
- Deliberate breaks:
  - simulation removed from `sendCreateSubPool` → `× simulates createSubPool(id) …`, `× names the refusals and never reaches the wallet …`, `Tests  2 failed | 4 passed (6)`; restored.
  - migration 0012 replaced by `SELECT 1;` → `× migrations > creates the 5 Emergency Pool sub-pools without the seed (0012)`, `Tests  1 failed | 16 passed (17)`; restored → `17 passed`.
- Full E2E suite: NOT RUN locally — CI runs it.

## Open questions / risks
- On-chain creation is a manual Operator step per network (Amoy-dev now; uat/prod at launch — through the Safe on prod, which this page cannot do; the prod launch runbook must name it).
- If dev's DB already had the rows (someone ran the seed), the migration inserts nothing — intended.

## Suggested commit message
feat(pool): Emergency Pool sub-pool rows by migration + admin page to create them on chain (TASK-046)
