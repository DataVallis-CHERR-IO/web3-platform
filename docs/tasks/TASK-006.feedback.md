# TASK-006 feedback — Ponder indexer (PR A + PR B)
Status: DONE

Everything is implemented and green locally. The only unproven item is the new CI job "Indexer scenario": it cannot run before the branch is pushed. When that job is green the task is DONE.

## What I implemented
PR A (merged, #15)
- Ponder **0.17.12** (exact pin); config resolved by `APP_ENV` (`lib/env.ts`): chain, deployment file, `startBlock`, RPC from `PONDER_RPC_URL_<chainId>`, database from `DATABASE_URL_DIRECT` only (PgBouncer URLs refused), pool max 8.
- All 13 tables; handlers for `CampaignCreated` and the 13 `Campaign` events.
- Internal read-only endpoints `/sql/*` and `/graphql`.
- `pnpm --filter indexer reconcile`; scenario test on Anvil + unchanged `DeployAmoy.s.sol` + Ponder + a throwaway database; ADR-026.

PR B (this change)
- `EmergencyPool` registered in `ponder.config.ts` with `startBlock` from the deployments JSON.
- Handlers for all 9 `EmergencyPool` events and the pool id 0 setup (`src/pool.ts`).
- Delivered amount of an allocation: strict match in the transaction receipt (`lib/delivered.ts`), stored in `allocation.delivered`.
- Reconcile extended to `pool`, `pool_contribution`, `allocation`, `allocation_vote`, `campaign.funding_pool_id` and delivered amounts.
- Scenario extended: campaign F (guardian paths), pool flows with campaigns D, E, G, the all-events check, and the `/status` block assertion.
- CI job "Indexer scenario".

## Event → handler → table (23 events)

| Contract | Event | Writes |
|---|---|---|
| CampaignFactory | `CampaignCreated` | insert `campaign` (state `LIVE`, counters 0) |
| Campaign | `Donated` | insert `donation`; upsert `campaign_donor`; `campaign.total_raised +=`; donor is the pool: `campaign.pool_donated +=` |
| Campaign | `PreferenceSet` | update `campaign_donor` preference, sub_pool_id |
| Campaign | `Finalized` | `campaign.state`, `end_time`; `FAILED`: `settlement_start` |
| Campaign | `PayoutModeSet` | `campaign.payout_mode` |
| Campaign | `TrancheReleased` | insert `tranche_release`; `campaign.released +=`, `fee_paid +=`; MILESTONES: `tranches_released + 1`; state `COMPLETED` or `PAYING` |
| Campaign | `EvidenceSubmitted` | insert `vote_round`; `campaign.state = VOTING`, `current_round`, `vote_end` |
| Campaign | `Voted` | insert `vote`; `vote_round.yes_votes` / `no_votes +=` |
| Campaign | `VoteClosed` | `vote_round` final votes, `outcome`, `closed_at`; `campaign.state`; `REJECTED`: `rejected_remainder`, `settlement_start` |
| Campaign | `Frozen` | insert `guardian_action` (FREEZE); `campaign.state = FROZEN`, `prev_state`, `frozen_at` |
| Campaign | `Resolved` | insert `guardian_action` (RESOLVE); `campaign.state`; unfrozen vote: `vote_end` extended; rejected: `rejected_remainder`, `settlement_start` |
| Campaign | `Refunded` | insert `refund`; `campaign_donor.settled`; `campaign.total_refunded +=` |
| Campaign | `SentToPool` | `campaign_donor.settled`; `campaign.total_sent_to_pool +=` |
| Campaign | `Swept` | `campaign.swept`; `total_sent_to_pool +=` |
| EmergencyPool | (setup, no event) | insert `pool` id 0 |
| EmergencyPool | `SubPoolCreated` | insert `pool` |
| EmergencyPool | `PoolDonated` | insert `pool_contribution` (DIRECT); `pool.balance +=`, `total_contributed +=` |
| EmergencyPool | `CampaignInflow` | insert `pool_transfer` (SETTLE, or SWEEP when donor is zero); `pool.balance +=`; donor non-zero: insert `pool_contribution` (CAMPAIGN), `total_contributed +=` |
| EmergencyPool | `AllocationProposed` | insert `allocation` (VOTING); `pool.balance -= amount`; `campaign.funding_pool_id` if empty |
| EmergencyPool | `AllocationVoted` | insert `allocation_vote`; `allocation.yes_votes` / `no_votes +=` |
| EmergencyPool | `AllocationClosed` | `allocation.state`; PASSED: `delivered` from the receipt, `pool.balance += amount − delivered`; REJECTED: `pool.balance += amount` |
| EmergencyPool | `AllocationDeliveryFailed` | `allocation.state = DELIVERY_FAILED`; `pool.balance += amount` |
| EmergencyPool | `AllocationResolved` | insert `guardian_action` (ALLOCATION_RESOLVE); `allocation.state`; RESOLVED_PASS: `delivered` from the receipt, `pool.balance += amount − delivered`; RESOLVED_REJECT: `pool.balance += amount` |
| EmergencyPool | `ReclaimedFromCampaign` | insert `pool_transfer` (RECLAIM); `pool.balance +=` on the campaign's funding pool, or pool 0 |

Not indexed: `PlatformConfig` events (approved) and OpenZeppelin's `Initialized`, which is the 24th event in the Campaign ABI; every clone emits it and it carries no platform state.

### Delivered amount (CTO decision, revised)
`getAllocation(id)` has no delivered field and a balance read is end-of-block, so the amount comes from the transaction receipt: the `Donated` log whose emitter is the allocation's campaign, whose donor is the EmergencyPool, and whose logIndex is lower than the allocation event's; the last such log wins. If a PASSED / RESOLVED_PASS allocation has no such log the handler throws and the indexer stops.

`includeTransactionReceipts` is **not** enabled, contrary to the approved plan: Ponder's `event.transactionReceipt` carries no logs. The two handlers call `context.client.getTransactionReceipt` instead (cached by Ponder; one call per delivered allocation, no cost for any other event).

## Files changed (PR B)
- `apps/indexer/src/pool.ts` — new, pool handlers
- `apps/indexer/lib/delivered.ts` — new, strict receipt matching
- `apps/indexer/lib/origin.ts` — new, event columns helper moved out of `src/index.ts`
- `apps/indexer/src/index.ts` — imports the helper
- `apps/indexer/ponder.config.ts` — registers `EmergencyPool`
- `apps/indexer/lib/reconcile.ts`, `scripts/reconcile.ts` — pool views, exported `checkpointBlock()` with format check
- `apps/indexer/test/scenario.test.ts` — F, D, E, G, pool assertions, all-events check, `/status` assertion
- `apps/indexer/test/delivered.test.ts`, `test/reconcile.test.ts` — new unit tests
- `apps/indexer/package.json` — `test` runs the three unit test files
- `.github/workflows/ci.yml` — job `indexer` ("Indexer scenario")
- `docs/tasks/TASK-006.feedback.md`

## Deviations from the task (and why)
- Schema is `chain_<sha7>` + views in `chain` + `ponder_sync` (ADR-026).
- Extra tables `campaign_donor`, `allocation_vote` and extra `campaign` columns (approved).
- Receipt fetched with `context.client.getTransactionReceipt` instead of `includeTransactionReceipts` (see above).
- The all-events check excludes OpenZeppelin's `Initialized`; the count of 23 is asserted after that exclusion.
- `checkpointBlock()` unit test pins a literal sample and the 75-digit shape; the check that fails on a Ponder format change is the scenario assertion that reconcile's block equals Ponder's `/status` block.
- Added a unit test file for the receipt matching (`delivered.test.ts`), not listed in the plan.
- The scenario runs Anvil with chain id 80002 and `MockUSDC` bytecode at the Amoy USDC address, so `DeployAmoy.s.sol` runs unchanged; it writes `packages/contracts/deployments/amoy-local-test.json` and deletes it in teardown.
- The corrupt-row check disables user triggers on the table for its update (Ponder's live-query trigger only works in Ponder's session).

## New dependencies
- PR B: none.
- PR A: `ponder@0.17.12`, `viem@^2.35.0`, `hono@^4.5.0`, `postgres@^3.4.5`, `@cherrio/contracts@workspace:*`; dev `vitest@^3.0.5`, `tsx@^4.19.3`.

## How to verify
1. `docker compose -f docker-compose.dev.yml up -d`; Foundry installed.
2. `export DATABASE_URL_DIRECT=postgres://cherrio:cherrio@127.0.0.1:5432/cherrio_dev`
3. `pnpm --filter indexer test` → 3 files, 15 tests passed.
4. `pnpm --filter indexer test:scenario` → 11 tests passed; output has `mismatches: 0`, then one `MISMATCH … total_raised` line and `mismatches: 1`.
5. Afterwards: no `cherrio_indexer_test_*` database, no `amoy-local-test.json`.
6. After push: the CI job "Indexer scenario" is green.

## Test results
- `pnpm --filter indexer test`: 3 files, 15 tests passed.
- `pnpm --filter indexer test:scenario`: 11 tests passed (about 19 s). Reconcile: `block=97 checked=309 mismatches: 0`; corrupted row: exactly 1 mismatch, exit 1.
- Scenario end state: pool 7 balance 500 USDC, total contributed 1,500; pool 0 balance 274, total contributed 174; allocations PASSED (400 delivered), DELIVERY_FAILED, RESOLVED_PASS (600 of 700 delivered), PASSED (50, later reclaimed).
- Deliberate failure (PR B): `CampaignInflow` stopped adding to `pool.balance` → 3 of 11 failed (pool test and both reconcile tests; `MISMATCH pool 0 balance: indexed=25000000 onchain=274000000`). Restored → 11 passed.
- Found by the scenario during development: the first receipt matcher decoded a campaign's `Finalized` log as if it were `Donated` and crashed on allocation 2; fixed by checking the decoded event name, and covered by `delivered.test.ts`.
- `pnpm --filter='!@cherrio/contracts' lint` and `typecheck`: all 8 projects Done.

## NOT RUN
- CI job "Indexer scenario" — NOT RUN; GitHub Actions cannot run from the laptop. The workflow file parses as YAML; nothing more is proven.
- Indexing real Amoy (`APP_ENV=dev`) — NOT RUN, no RPC key in this session.
- Ponder in a container and memory use at 384 MB — NOT RUN.
- `forge test`, `pnpm --filter web test`, `next build`, e2e, `docker build` — NOT RUN in PR B (no file of theirs changed).
- Allocation outcomes `REJECTED` and `RESOLVED_REJECT`, and a `DELIVERY_FAILED` reached through `resolveAllocation` — handlers written, NOT RUN in the scenario.

## Open questions / risks
- Reconcile cannot find a campaign the indexer never saw (the factory has no campaign list).
- Finality is hard-coded in Ponder: 30 blocks on Amoy (accepted), 200 on Polygon (review in TASK-023). A deeper reorg stops the indexer and needs a re-index.
- Alchemy free tier limits `eth_getLogs` ranges; a full re-index gets slower as the chain grows.
- The scenario test and the CI job need a role with `CREATEDB`.
- A `DELIVERY_FAILED` allocation reached through `resolveAllocation` emits no `AllocationResolved`, so it leaves no `guardian_action` row (contract behaviour).

## Follow-ups (not implemented)
- Deploy: `Dockerfile.indexer`, Kamal service `cherrio-indexer-<env>`, deploy job, secret `PONDER_RPC_URL_<chainId>`.
- Separate DB role for the indexer with no rights on `app` — mandatory before prod.
- Connection budget: `cherrio_dev` role limit is 20 and PgBouncer `default_pool_size` is 20; the indexer's 8 direct connections must be accounted for in infra before deploy.
- Pruning old `chain_<sha7>` schemas (`ponder db prune`).
- Prometheus scrape of `/metrics`.

## Suggested commit message
feat(indexer): EmergencyPool handlers, pool reconcile and CI scenario job (TASK-006 PR B)

## Closure (TASK-027)

The one item this file left open, the CI job "Indexer scenario", has run:

- CI run 36923510253: job "Indexer scenario" `success` (reference from the TASK-027 task file).
- Deploy run 36923510353 on `dev` (2026-10-01): indexer job steps Deploy, Wait for /ready, Reconcile, Prune all `success` (same source).

Reconcile against amoy-dev, outputs provided by David on 2026-10-02, verbatim.

Deploy run 36973809232 (merge of PR #18, commit 31a0a61), step "Reconcile against the chain":
```
  INFO [395db37b] Running docker exec cherrio-indexer-dev-indexer-dev-sha-31a0a61 node dist/reconcile.mjs on <server>
  INFO [395db37b] Finished in 0.873 seconds with exit status 0 (successful).
App Host: <server>
reconcile: schema=chain block=49100332 checked=4 mismatches: 0
```

On the server (deploy@cherrio-1), 2026-10-02:
```
== reconcile
reconcile: schema=chain block=49101007 checked=4 mismatches: 0
```

Only 4 values are compared because no campaign exists on amoy-dev yet; they are Emergency Pool state. The handlers for all 23 events are proven by the scenario test, not by dev data. All server outputs: `docs/tasks/TASK-026.feedback.md`, "Server results (TASK-027)".

The opening paragraph and the "NOT RUN" section above are kept as written at the time; the CI item in them is closed by this section. Real Amoy indexing, listed there as not run, is live on dev.
