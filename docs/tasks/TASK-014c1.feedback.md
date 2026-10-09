# TASK-014c-1 feedback — propose an Emergency Pool allocation with a public reason
Status: DONE (Built, PR pending)

## What I implemented
- **Admin → Emergency Pool → "Propose an allocation"** (`ProposeAllocation.tsx`): sub-pool on chain (with its balance), live campaign, amount in USDC (> 0, ≤ the sub-pool balance), public reason (1–1,000 characters). Flow: `POST /api/admin/emergency-pool/allocations/reason` stores the reason and returns `reasonHash` = SHA-256 of the trimmed UTF-8 text → the Operator wallet signs `EmergencyPool.proposeAllocation(poolId, campaign, amount, reasonHash)` after a simulation through `/api/rpc` → `POST …/allocations/sent` audits the transaction.
- `lib/pool/allocations.ts`: `reasonHash`, `normalizeReason` (trim, `\r\n` → `\n`), `proposableCampaigns` (DEPLOYED + `chain.campaign` LIVE + before the deadline), `saveAllocationReason` (idempotent per text; audit `pool.allocation_reason_saved` with `reused`), `recordAllocationSent` (audit `pool.allocation_propose.sent`).
- `lib/pool/allocation-client.ts`: simulate → send; every contract refusal of `proposeAllocation` named (NotOperator, PoolDoesNotExist, NotLiveCampaign, NotFactoryCampaign, InsufficientPoolBalance, CampaignDeadlineTooSoon, PoolIdMismatch, AmountZero).
- Migration `0024`: `app.pool_allocation_reasons` (hash format and text length checked in the database).
- Public page: each allocation shows its reason with "Check: SHA-256 of this text = …", or "not published on CHERR.IO (hash …)".
- `useOperator.ts`: the Operator-wallet check shared by "Create sub-pools" and "Propose an allocation" (moved out of `SubpoolActions.tsx`, no behaviour change). Removed the last "Back" link on the admin Emergency Pool page (TASK-021 menu).
- Found while checking screenshots: a textarea with `.ch-input` alone has no frame — wrapped in `.ch-field-row` here and in the rating comment (`RatingPanel.tsx`, same bug since TASK-057).
- Owner guide v1.10 (§8 "Proposing an allocation from a sub-pool"), docs 03, 04, 09, donors guide, tasks README, spec status; 014b labels flipped to Live on dev.

## Deviations from the task (and why)
- TASK-014c is split in three PRs: c-1 propose (this), c-2 vote + count on the public page, c-3 Guardian decision in Admin → Chain actions.
- The new table ships in the same PR as the code (not expand/contract): it is a new table, not a column of a table read with `select()`. Until the migration runs after the deploy (≤ 1 minute) the public page shows "being refreshed" and the admin save fails with "could not be saved" — accepted like earlier new tables.

## New dependencies
- none

## How to verify
1. https://dev.cherr.io/en/admin/emergency-pool → "Propose an allocation": the sub-pools with their balance and the live campaigns are offered; with 0 USDC in every sub-pool the amount check says "This sub-pool has only 0.00 USDC available." — give to a sub-pool first (014b).
2. With money in a sub-pool and a live campaign whose deadline is more than the vote window away: amount, reason → **Propose and sign** → MetaMask (Operator 0x4326…B5a7) → "Proposed."; a few minutes later https://dev.cherr.io/en/emergency-pool shows the vote with the reason and its SHA-256.

## Test results
`pool-allocations.test.ts` (new): browser call (simulate then send; 8 named refusals; wrong network), SHA-256 and normalisation, proposable campaigns, idempotent save + audits, both routes (404 for anonymous and non-admin, 400 for amount 0), public page join. With `pool-public`, `admin-subpools`: `Tests  17 passed (17)`.
Deliberate break — the hash taken of the raw input instead of the stored (trimmed) text:
```
   × … stores the reason once per text and audits each save; a draft campaign or an empty reason is refused
     → expected { ok: true, …(2) } to deeply equal { ok: true, …(2) }
   × … the public page shows the published reason for the allocation whose reasonHash matches
     → expected { id: '930201', poolId: 2, …(15) } to match object { …(3) }
      Tests  2 failed | 5 passed (7)
```
Restored. `pnpm --filter web test`: `Tests  604 passed (604)`. typecheck, lint clean; `check:design` passed.
E2E `admin-emergency-pool.spec.ts` (new test: propose with the fake Operator wallet → calldata `proposeAllocation(id, campaign, 7_500_000, sha256(reason))`, both audits, the public page shows the reason and hash; a11y on the form) + `guardian.spec.ts`: first run failed — the fake admin wallet answered `0x` for every simulation and `proposeAllocation` returns a value; the helper now answers one zero word for it → `12 passed`.
Screenshots 1440/390 (temporary lines in the spec, removed): form and the public vote card checked; the unframed textarea fixed after the first look.
Full E2E: `254 passed (10.0m)`.

## Open questions / risks
- The reason is public as soon as the vote shows; an admin who proposes by mistake cannot withdraw it (the contract has no cancel) — the Guardian can only decide after a vote without quorum. Worth a sentence in the owner guide later if it happens.

## Suggested commit message
feat(pool): propose an Emergency Pool allocation with a public reason (TASK-014c-1)
