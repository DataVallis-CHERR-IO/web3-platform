# TASK-014a feedback — Emergency Pool public page
Status: DONE — live on dev (PR #200 indexer, Deploy 37985675255; PR #201 page, Deploy 37986650113)

## What I implemented
- **Indexer (PR #200):** `chain.allocation.snap_quorum_bps` / `snap_approval_bps` — `AllocationProposed` has no vote rule, so the handler reads `getAllocation(id)` once at the proposal block. Reconcile compares both columns with the contract.
- **Page `/en/emergency-pool`** (`app/[locale]/emergency-pool/page.tsx`, `lib/pool/public.ts`): four-step explanation; total available; one card per sub-pool on chain (available, credited contributions, contributors); the 20 newest allocations with state in words, amount, sub-pool, campaign link (or short address), sent amount when less than proposed, vote end, turnout vs quorum, yes share vs approval, yes / no / eligible weight. Eligible weight = `chain.pool_contribution` with `block_number < proposal_block` (the contract uses checkpoints at `proposalBlock − 1`). `voteFigures` uses the integer arithmetic of `closeAllocation`. Missing view or column → "being refreshed" notice instead of an error.
- Fake chain tables for tests: `chain.pool_contribution`, `chain.allocation` (`src/__tests__/helpers/fake-chain.ts`).

## Files changed
- `apps/indexer/ponder.schema.ts`, `apps/indexer/src/pool.ts`, `apps/indexer/lib/reconcile.ts`, `apps/indexer/test/scenario.test.ts` (PR #200).
- `apps/web/src/lib/pool/public.ts` (new), `apps/web/src/app/[locale]/emergency-pool/page.tsx`, `apps/web/messages/en.json` (`emergencyPool.*`; removed unused `comingSoon.epTitle/epDesc`), `packages/ui/src/styles/components.css` (`.ch-pool-how`, `.ch-pool-grid`, `.ch-pool-figures`).
- Tests: `apps/web/src/__tests__/pool-public.test.ts` (new), `apps/web/e2e/emergency-pool.spec.ts` (new), `e2e/auth-nav.spec.ts` (the page is no longer "Coming soon"), fake chain helper.
- Docs: spec `TASK-014-emergency-pool.md`, technical 03, 04, 09, guide `donors.md`, tasks README.

## Deviations from the task (and why)
- The indexer part shipped as its own PR first (the page reads the new columns; the views switch to the new schema only after it caught up). The page still works before that — it shows the refresh notice.
- Pool names: a sub-pool without a translated name shows "Pool <id>" (`t.has`), so a new theme never breaks the page.

## New dependencies
- none

## How to verify
1. After the deploy (and the indexer catching up): https://dev.cherr.io/en/emergency-pool → "Emergency Pool", "How it works" with four steps, "Sub-pools" with General, Medical emergencies, Natural disasters, Animals in danger, Climate (the five created on Amoy-dev) and "Available now" per card.
2. "Allocation votes" says "No allocation has been proposed yet." until 014c lets the Operator propose one.

## Test results
Indexer scenario (Anvil + Ponder + Postgres): `Tests  14 passed (14)` — all seven allocations `[2500, 5100]`.
Deliberate break — `snapApprovalBps` written from the quorum value:
```
MISMATCH allocation 0 snap_approval_bps: indexed=2500 onchain=5100
…
reconcile: schema=chain block=113 checked=475 rpc_requests=12 repeated_reads=0 mismatches: 7
```
Indexer unit tests: `Tests  53 passed (53)`.

Web, `pool-public.test.ts`: `Tests  4 passed (4)`. Deliberate break — eligible weight with `block_number <= proposal_block` (a gift in the proposal block itself would count):
```
   × public Emergency Pool page (Postgres) > allocations newest first; eligible weight counts only contributions before the proposal block
     → expected { id: '930101', poolId: 9301, …(13) } to match object { amount: 2000000n, …(7) }
```
`pnpm --filter web test`: `Tests  592 passed (592)`. `typecheck`, `lint` clean; `check:design`: `Design check passed — no violations found.`

E2E (`emergency-pool`, `auth-nav`, `a11y`, `admin-emergency-pool`): first run 2 failed — my spec expected "9 USDC", the page prints "9.00 USDC"; fixed the expectation → `emergency-pool.spec.ts` + screenshot spec `6 passed`; the rest `106 passed` in the first run.
Screenshots 1440 / 390 checked (temporary spec): on the first 390 shot the allocation figures overlapped (two columns too narrow) and a full 42-character address wrapped — fixed (label above value on phones, short address with the full one as title), re-checked.

## Open questions / risks
- Up to 20 allocations are listed; paging comes when there are more.
- The `pool_contribution` sum per allocation is a sub-select per row (20 rows, indexed by pool via the view's table) — fine at this size.

## Suggested commit message
feat(pool): public Emergency Pool page — sub-pools and allocation votes (TASK-014a)
