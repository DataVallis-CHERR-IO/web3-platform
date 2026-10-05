# TASK-047 feedback
Status: DONE (code, tests, benchmark, docs)

## What I implemented
- Chain hex columns compared as stored (no `lower()`): `lib/campaigns/public.ts`, `lifecycle.ts`, `evidence.ts`, `publish.ts`, `lib/admin/guardian.ts`. Verified first that Ponder lower-cases every `t.hex()` value (`node_modules/ponder/dist/esm/drizzle/hex.js`, `mapToDriverValue` → `toLowerCase()`), and that `app.campaigns.onchain_address` / `app.user_addresses.address` have lower-case check constraints.
- `listPublicCampaigns` → page CTE (ids + sort keys) + `summariesOf` (cover, organisation, donor count for the page only).
- `listLiveCampaigns` + `countPublicCampaigns`; `getLandingCampaigns` uses them. Partial index `campaigns_public_deadline_idx` (migration `0013`).
- `loadLifecycles` (batch; `loadLifecycle` now calls it) and `loadUserPositionsMany` (`loadUserPositions` calls it); `listMyCampaignDonations` uses three queries in all.
- Fake chain helper: indexer's secondary indexes + lower-case check constraints.
- Benchmark `src/__perf__/campaign-lists.perf.ts` + `vitest.perf.config.ts` + `pnpm --filter web perf:campaigns`; CI step "Campaign list speed (10,000 campaigns)".

## Files changed
- apps/web/src/lib/campaigns/public.ts, landing.ts, lifecycle.ts, evidence.ts, publish.ts; apps/web/src/lib/admin/guardian.ts — queries
- packages/db/src/schema/campaigns.ts, packages/db/drizzle/0013_campaigns_public_deadline_idx.sql (+ snapshot, journal) — index
- apps/web/src/__tests__/helpers/fake-chain.ts — indexes + checks
- apps/web/src/__tests__/landing-campaigns.test.ts — consistency test
- apps/web/src/__perf__/campaign-lists.perf.ts, apps/web/vitest.perf.config.ts, apps/web/package.json — benchmark
- .github/workflows/ci.yml — CI speed step
- docs: this feedback, `TASK-047-campaign-list-speed.md`, `tasks/README.md`, `technical/03`, `04`, `07`, `09`

## Deviations from the task (and why)
- The worker's `notify/enqueue.ts` keeps `lower()`: it runs once a minute in the background and joins by hash, not per row; left for a later pass.

## New dependencies
- none

## How to verify
1. `createdb`-style: a database whose name contains `perf`, migrated (`pnpm --filter @cherrio/db migrate`).
2. `DATABASE_URL=…/cherrio_perf pnpm --filter web perf:campaigns` → 12 cases, each prints `[perf] <name> <median> ms (budget …)`; all pass.

## Test results
Benchmark, same database (10,000 published campaigns, 100,303 donor rows, 100,000 donations, local Postgres 16, median of 7):

| Case | Before (dev code) | After |
|---|---|---|
| /campaigns page 1 | 1,379 ms | 20.5 ms |
| /campaigns last page | > 120 s (stopped; first run) | 23.7 ms |
| /campaigns cause + 2 countries | 1,277.9 ms | 11.3 ms |
| filter facets (no filter / cause + country) | 6.5 / 5.5 ms | 8.5 / 8.3 ms |
| landing (hero + grid) | 1,382.5 ms | 3 ms |
| campaign page | 56 ms | 1.6 ms |
| campaign page donor ledger | 105.8 ms | 2 ms |
| admin campaigns (live view / search) | 16.4 / 15.4 ms | 26.8 / 18.2 ms |
| admin campaign counts | 1.1 ms | 1.2 ms |
| my donations (300 campaigns) | 21,080.4 ms | 39.9 ms |

With 50,000 campaigns (after): page 1 59.4 ms, last page 137.6 ms, filters 41.4 ms, facets 35.6 / 23.4 ms, landing 9.3 ms, campaign page 1.9 ms, ledger 1.7 ms, admin 48.7 / 71.8 ms, counts 6 ms, My donations 40.6 ms — `Tests  12 passed (12)`.

- `pnpm --filter web test`: `Test Files  54 passed (54)`, `Tests  477 passed (477)` (before the new landing test), then `landing-campaigns.test.ts` `Tests  6 passed (6)`.
- `pnpm --filter worker test`: `Tests  6 passed (6)` (against the stricter fake tables).
- lint / typecheck: no errors; `pnpm check:design`: "Design check passed — no violations found."
- E2E (local build): landing, campaigns, campaign-pages, lifecycle, donate, guardian, campaign-card-layout, campaign-filters, evidence, notifications → `44 passed (2.1m)`.
- Fake chain check: `insert into chain.campaign_donor … ('0xABC', …)` → `violates check constraint "campaign_donor_campaign_lower"`.
- Deliberate breaks:
  - `lower()` back in `chainJoin` and the donor count → `/campaigns page 1 1274.9 ms (budget 150)`, last page 856.7 ms, filters 1329 ms, landing 265.1 ms, campaign page 59.6 ms → 5 failed; restored.
  - `listLiveCampaigns` ordered by `deadline desc` → `× listLiveCampaigns is the live head of listPublicCampaigns, in the same order`, `Tests  1 failed | 5 passed (6)`; restored. (A first version of the test with limit 8 did not fail on this break because fewer than 8 live campaigns existed; it now uses limit 2.)

## Open questions / risks
- Budgets are for CI runners (5–7× the local medians); a very slow runner could flake — the step prints every median.
- Beyond ~50,000 published campaigns the `/campaigns` sort grows linearly (138 ms for the last page at 50,000); next step would be a precomputed sort key.
- The benchmark measures the database side only; page render time on dev also includes Next.js rendering and the FX rates.

## Suggested commit message
perf(campaigns): index-friendly chain joins, page-then-decorate lists, landing via partial index, batched My donations (TASK-047)
