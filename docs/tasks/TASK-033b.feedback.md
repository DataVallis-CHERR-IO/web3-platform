# TASK-033b feedback (donor side) — in parts
Status: PARTIAL — part 1 of 3 (indexer snapshots)

033b is split into three PRs to stay under ~800 lines each:
1. **Indexer: per-campaign PlatformConfig snapshot** (this PR).
2. Lifecycle read model (`lib/campaigns/lifecycle.ts`), client helpers (`lifecycle-client.ts`), API (`GET /api/lifecycle/:campaign`, `GET /api/me/donations`).
3. UI: lifecycle panel on the campaign page, "My donations", "votes waiting" badge, E2E.

## Part 1 — what I implemented
- `apps/indexer/ponder.schema.ts`: `campaign.snap_fee_bps`, `snap_success_threshold_bps`, `snap_refund_sweep_delay`, `snap_vote_window`, `snap_quorum_bps`, `snap_approval_bps`, `snap_release_delay` (integer, not null).
- `apps/indexer/src/index.ts` `CampaignCreated`: reads the 7 `Campaign.snap*()` views of the new clone at the event block (the clone is initialized in the same tx). Separate `readContract` calls; no Multicall3 (local Anvil has none).
- `apps/indexer/lib/reconcile.ts`: the 7 columns join the direct column → view comparison (26 columns).
- `apps/indexer/test/scenario.test.ts`: campaign A asserts the snapshot (deploy keeps the source defaults: 1 %, 10 %, 180 d, 7 d, 25 %, 51 %, 3 d); reconcile in the scenario compares every campaign's snapshot with the chain.

Why: the campaign page must show each campaign's **own** vote window and quorum. On Amoy-dev, campaigns published before 2026-10-04 10:55 have 24 h / 50 %, later ones 1 h / 25 % (David's test values) — today's PlatformConfig cannot tell them apart.

## Deviations
- The spec allowed falling back to ADR-045 constants; indexing the real values made that unnecessary for the indexer. The web read model (part 2) still tolerates a view without these columns (during a deploy) and marks the values as unknown.

## New dependencies
- none

## How to verify
1. CI "Indexer scenario" (Anvil + Ponder) green: snapshot assertions + reconcile with 0 mismatches.
2. After the deploy on dev the indexer rebuilds into a new `chain_<sha7>` schema (column change) and backfills; `chain.campaign` then has the `snap_*` columns.

## Test results (this session)
- `pnpm --filter indexer typecheck`, `lint`: clean.
- `pnpm --filter indexer test`: `Test Files  4 passed (4)`, `Tests  26 passed (26)`.
- Scenario: NOT RUN locally — needs Anvil/forge broadcast, CI only (HANDOFF).

## Open questions / risks
- The indexer redeploy on dev backfills from the factory start block (ADR-026) — the known "indexer memory under full backfill" item; watch the Deploy run's Ready step.
