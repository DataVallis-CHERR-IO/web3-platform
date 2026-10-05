# TASK-047 — Campaign lists fast with thousands of campaigns

Status: Built (PR pending) · Owner: cloud session (CTO + implementer) · Requested by David, 2026-10-05 ("hitrost je zelo pomembna, ko bomo meli na tisoče kampanj mora to hitro delat")
Depends on: TASK-011a (public pages), TASK-033b (lifecycle, My donations), TASK-037 (landing), TASK-042 (filters).

## Why
Nobody had measured the pages with more than a handful of campaigns. A benchmark with 10,000 published campaigns showed `/campaigns` at ~1.3 s, its last page over 2 minutes, the landing ~1.4 s and "My donations" ~21 s. Cause: every query compared chain hex columns as `lower(ch.address) = …`, which defeats the primary keys and indexes of the indexer's tables (Ponder already stores hex lower-case), so each campaign card counted its donors with a sequential scan of all donors.

## Scope
1. Compare chain hex columns without `lower()` in the web app (public lists, ledger, lifecycle, My donations, admin chain queue, evidence, publish linking); parameters stay lower-cased.
2. `listPublicCampaigns`: select the page's ids and sort keys first, then decorate only those rows (`summariesOf`).
3. Landing: `listLiveCampaigns(limit)` through a partial index on `campaigns(deadline, id)` for published campaigns (migration `0013`) + `countPublicCampaigns`.
4. "My donations": `loadLifecycles` + `loadUserPositionsMany` (three queries in all).
5. Fake chain tables in tests: the indexer's secondary indexes and lower-case checks.
6. Benchmark `pnpm --filter web perf:campaigns` (own `*perf*` database, 10,000 campaigns by default, budgets per query) and a CI step running it.

## Out of scope
Worker notification queries (background, once a minute), the full sort behind `/campaigns` beyond ~50,000 campaigns (a precomputed sort key would be the next step), Ponder indexes on `chain.donation (campaign, block_number, log_index)`.

## Tests
- Existing Vitest + E2E suites unchanged and green (they now run against fake tables that reject non-lower-case hex).
- New Vitest: `listLiveCampaigns` is the live head of `listPublicCampaigns` (deliberate break: deadline order reversed → fails).
- Benchmark as a guard (deliberate break: `lower()` back in the join → page 1 1,275 ms vs budget 150 → fails).
