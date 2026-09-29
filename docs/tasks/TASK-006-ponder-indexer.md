# TASK-006 — Ponder indexer

Read first: `docs/02-ARCHITECTURE.md` §4.2, TASK-004 and TASK-005 feedback.

## Scope
- `apps/indexer` Ponder config selected by `APP_ENV`: dev → Amoy 80002 + `deployments/amoy-dev.json`, uat → Amoy 80002 + `amoy-uat.json`, prod → Polygon 137 + `polygon.json`; RPC from env `PONDER_RPC_URL_<chainId>`. Each environment runs its own indexer instance.
- Contracts: `CampaignFactory`, `Campaign` (factory pattern from `CampaignCreated`), `EmergencyPool`.
- Postgres schema **`chain`** (Ponder `DATABASE_SCHEMA=chain`) in the same DB as `app`.
- Tables: `campaign` (address, offchain_id, beneficiary, target, deadline, state, total_raised, payout_mode, released, fee_paid, current_round), `donation` (tx, log index, campaign, donor, amount, preference, sub_pool, block time), `vote_round`, `vote`, `tranche_release`, `refund`, `pool_transfer`, `pool` (id, balance, total_contributed), `pool_contribution`, `allocation`, `guardian_action`.
- Handlers for every event from TASK-002..004. State must equal contract view functions.
- Read-only GraphQL/SQL endpoint enabled for internal use only (not exposed publicly by kamal-proxy).
- A reconciliation script `pnpm --filter indexer reconcile` that compares indexed `campaign` rows with on-chain `state()`/`totalRaised()` for all campaigns and prints mismatches.

## Tests
- Run against local Anvil with the TASK-004 deploy script + a scripted scenario (create 3 campaigns: success-single, milestones-reject, fail-to-pool); assert DB rows.

## Must not touch
`docs/**`, `packages/contracts/src/**`, `packages/db/**` (app schema).

## Acceptance criteria
- Scenario test green; reconciliation reports zero mismatches.
- Feedback lists every event → table mapping.
