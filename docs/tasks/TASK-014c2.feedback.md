# TASK-014c-2 feedback — vote and count on the public Emergency Pool page
Status: DONE (Built, PR pending)

## What I implemented
- **Vote** (open allocations): `components/pool/AllocationVote.tsx` looks up the visitor's wallet weight through the new public `GET /api/pool/allocations/:id/voter?address=` (`voterStatus`: that address's `chain.pool_contribution` to the sub-pool before the proposal block — the rule of `voteAllocation` — and whether `chain.allocation_vote` has its vote). Shows "Your vote counts X USDC" + **Vote yes / Vote no**, "no vote here" without weight, "already voted".
- **Count** (vote time over, still VOTING): **Count the vote** for anyone → `closeAllocation(id)`.
- `lib/pool/vote-client.ts`: simulate through the wallet, then send; `AllocationNotVoting`, `VoteEnded`, `VoteNotEnded`, `AlreadyVoted`, `NoVotingWeight` named; a CHERR.IO smart account sends one sponsored call.
- Fake chain table `chain.allocation_vote` for tests; the E2E giver wallet answers the vote/count simulations.
- Docs: technical 04, 09 (+ 03 label), donors guide (how to vote), owner guide **v1.11** (§8: voting and counting are public), tasks README, spec; 014c-1 labels flipped to Live on dev.

## Deviations from the task (and why)
- No email to contributors when a vote opens (the spec said "only if cheap"): it needs a new notification kind, a worker job over all contributors of a pool and a template — left for later.
- The vote is final per wallet (the contract has no change of vote); the page says so in the donors guide.

## New dependencies
- none

## How to verify
1. Give to a sub-pool (014b), then let the Operator propose an allocation from it (014c-1). Before the proposal is mined the gift must be in a block — gifts after the proposal give no weight in that vote.
2. https://dev.cherr.io/en/emergency-pool → the allocation card: "Your vote counts … USDC" → **Vote yes** → one MetaMask confirmation → "You voted yes."; after the next indexer cycle "Yes votes" moves.
3. On Amoy-dev the vote window is 1 hour: after it, **Count the vote** → "The vote is counted." → the state becomes "Approved — sent" or "Not approved — returned to the pool" (or "Too little turnout — CHERR.IO decides").

## Test results
`pool-vote.test.ts` (new): browser call (simulate then send for vote and count; smart account batch; five named refusals; wrong network; cancelled wallet), voter weight and the public route on Postgres. With `pool-public` and `pool-allocations`: `Tests  16 passed (16)`.
Deliberate break — weight counted with `block_number <= proposal_block`:
```
   × voter weight (Postgres, fake chain) > weight = gifts to that sub-pool before the proposal block; another pool's gifts do not count; a vote is remembered
     → expected { weight: 7000000n, voted: false } to deeply equal { weight: 4000000n, voted: false }
   × voter weight (Postgres, fake chain) > the public route validates its input and answers 404 for an unknown allocation
```
Restored. `pnpm --filter web test`: `Tests  609 passed (609)`; `@cherrio/db test:integration`: `Tests  19 passed (19)`; typecheck, lint clean; `check:design` passed.
E2E `emergency-pool.spec.ts` (new: weight + Vote yes → `voteAllocation(id, true)`; vote end passed → "Count the vote" → `closeAllocation(id)`; no weight → no buttons) + `admin-emergency-pool.spec.ts`: `20 passed`. Screenshot of the vote card at 390 checked.
Full E2E: `258 passed (9.9m)`.

## Open questions / risks
- **Prod Gas Manager allow-list:** add `EmergencyPool.voteAllocation` and `closeAllocation` (noted in HANDOFF).

## Suggested commit message
feat(pool): vote on and count Emergency Pool allocations (TASK-014c-2)
