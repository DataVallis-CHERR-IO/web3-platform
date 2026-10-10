# TASK-014 — Emergency Pool page, pool donations and allocation votes

Status: In progress — 014a live on dev (PR #200 indexer, Deploy 37985675255; PR #201 page, Deploy 37986650113); 014b live on dev (PR #204, Deploy 38003353787); 014c-1 live on dev (PR #205, Deploy 38008574099); 014c-2 vote + count live on dev (PR #206, Deploy 38016898534); 014c-3 Guardian next. Decision: David 2026-10-09 ("nadaljuj" on the CTO proposal in `HANDOFF.md` → Next).
Product rules: `01-PRODUCT-SPEC.md` §2.5; contract `packages/contracts/src/EmergencyPool.sol` (no contract change); sub-pools from TASK-046; vote parameters ADR-045.

## What already exists
- **Contract:** sub-pools; `donate(poolId, amount)`; inflows from failed/rejected campaigns (with donor credit) and sweeps (without); `proposeAllocation(poolId, campaign, amount, reasonHash)` (Operator; campaign LIVE and its deadline after the vote end); `voteAllocation(id, approve)` — weight = what the voter contributed to that pool before the proposal block (checkpoints); `closeAllocation(id)` (anyone after `voteEnd`; quorum and approval snapshotted at proposal; no quorum or no credited contributors → `NEEDS_REVIEW`); `resolveAllocation(id, approve)` (Guardian).
- **Indexer:** `chain.pool`, `chain.pool_contribution` (DIRECT / CAMPAIGN), `chain.pool_transfer` (SETTLE / SWEEP / RECLAIM), `chain.allocation`, `chain.allocation_vote`.
- **Web:** Admin → Emergency Pool creates sub-pools on chain (TASK-046); the donate panel lets donors choose a sub-pool for the failure case. The public `/emergency-pool` page is a "Coming soon" placeholder.

## Parts
### 014a — public page (read-only)
- Indexer: store the allocation's snapshotted `quorumBps` / `approvalBps` (one `getAllocation(id)` read at the proposal block) so the page can show the rule each vote is judged by.
- `/en/emergency-pool`: what the pool is and how money gets in and out; total balance and one card per sub-pool on chain (balance, credited contributions, number of contributors); allocations newest first — campaign (linked), sub-pool, amount, state in words, vote end, yes / no weight, turnout against the eligible weight (credited contributions before the proposal block) and the quorum, approval share. Works without JavaScript; amounts in the display currency (ADR-040).
- Header/landing links stay; the page leaves "Coming soon".

### 014b — give to a sub-pool
- "Give to this pool" on each sub-pool card: amount in USDC, `approve` + `donate(poolId, amount)` from the signed-in user's wallet (same wallet paths as campaign donations), minimum = the contract's (`AmountTooLow`). The gift gives voting weight in that pool for later proposals.

### 014c — allocations: propose, vote, close, resolve
- Admin → Emergency Pool: "Propose an allocation" (Operator wallet): sub-pool, live campaign, amount, public reason (≤ 1,000 characters). The reason is stored off-chain (`app.pool_allocation_reasons`: allocation hash → text) and `reasonHash = SHA-256(reason UTF-8)`; the page shows the text and marks it verified when the hash matches the chain.
- Public page: contributors of the pool vote yes/no from their wallet while the vote is open (weight shown before signing; "you have no weight in this pool" otherwise); "Count the vote" (`closeAllocation`) for anyone after the end.
- Admin → Chain actions lists `NEEDS_REVIEW` allocations for the Guardian (`resolveAllocation`), audited like campaign resolves.
- Notifications to contributors of the pool when a vote opens (worker, existing email path) — only if cheap; otherwise later.

## Not in scope
Yield on pool funds, automatic proposals, new contract functions, CHR.

## Tests
Vitest on Postgres for the page queries (balances, eligible weight before the proposal block, states), indexer scenario for the new snapshot columns, E2E for the page (axe, no JS needed), wallet flows with the E2E fake wallet in 014b/014c.
