# TASK-033b feedback (donor side) — in parts
Status: DONE — part 1 Live on dev (PR #76, Deploy run 37194265246), part 2 (PR #77, Deploy run 37195387503), part 3a (PR #78, Deploy run 37200474703); part 3b in this PR

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

## Part 2 — lifecycle read model, client helper, API
### What I implemented
- `apps/web/src/lib/campaigns/lifecycle.ts`: types (`CampaignLifecycle`, `DonorPosition`, `VoteRound`, `Snapshot`), pure rules `voteTally`, `dueActions`, `settlementAmount`, `donorAction`, `votesWaiting` (mirroring `Campaign.sol`), loaders `loadLifecycle`, `loadUserPositions`, `listMyCampaignDonations`, JSON helpers.
- `apps/web/src/lib/campaigns/lifecycle-client.ts`: `sendLifecycle` — chain check on the wallet, `simulateContract` from the sending address through the reader, then `sendCalls` (smart account) or `writeContract`; `toLifecycleFailure` maps `Campaign.sol` errors to fixable codes; `encodeLifecycle`.
- `GET /api/lifecycle/:campaign` (public + own positions), `GET /api/me/donations` (session).
- `fake-chain.ts`: the campaign lifecycle and `snap_*` columns (snap nullable here to stand for a view without them), `chain.vote_round`, `chain.vote`.
- `donate-client.ts`: `errorText` exported (reused).

### Deviations
- One `sendLifecycle(action)` instead of six functions; the action is a tagged union (same calls, less code, one tested path).
- Simulation instead of hand-written pre-checks: the contract's own error names are the pre-check, so nothing can drift from `Campaign.sol`.
- Snapshot unknown → `null` and "unknown" results; no fallback to ADR-045 constants (would be wrong for the 24 h / 50 % Amoy campaigns).

### Test results (this session)
- `vitest run src/__tests__/lifecycle.test.ts`: `Tests  13 passed (13)`
- `vitest run src/__tests__/lifecycle-db.test.ts`: `Tests  4 passed (4)`
- `vitest run src/__tests__/lifecycle-client.test.ts`: `Tests  6 passed (6)` (first run: 1 timed out — viem's custom transport retried each revert ~1 s; fixed with `retryCount: 0` on the wallet client)
- Deliberate break 1: quorum `>=` → `>` in `voteTally` → `× … exactly 25 % passes, just below does not`, `× … pool donations do not count towards the base` → `Tests  2 failed | 11 passed (13)`; restored.
- Deliberate break 2: simulation skipped in `sendLifecycle` → `× … simulates from the donating address …`, `× a refused simulation never reaches the wallet, and is named`, `× a frozen campaign says so`, `× with a reader, …` ; restored.
- `pnpm --filter web test`: `Test Files  41 passed (41)`, `Tests  384 passed (384)`; typecheck, lint, design check clean.
- E2E: not touched in this part (no UI) — CI runs the suite.

### Open questions / risks
- `lifecycle-db.test.ts` "My donations" counts `votesWaiting` = 1 using the VOTING campaign from the first test in the same file (tests in a file run in order).
- The UI (part 3) must create its `/api/rpc` reader with `retryCount: 0` as well, for the same reason.

## Part 3a — lifecycle panel on the campaign page
### What I implemented
- `lib/campaigns/lifecycle-view.ts`: `panelView(lifecycle, positions, now)` → stage (ending, awaiting-plan, release-wait, release-due, paying, voting, vote-over, needs-review, completed, failed, rejected, frozen), triggers (finalize / closeVote / release), payment number (2 or 3), positions; `shortAddress` (checksummed), `bpsPercent`.
- `components/campaigns/lifecycle-signers.ts`: every connected external wallet + the CHERR.IO smart account; `signerFor(address)`, `anySigner` (smart account first); E2E wallet when `APP_ENV=local`.
- `components/campaigns/LifecyclePanel.tsx`: the panel; actions through `sendLifecycle` with the `/api/rpc` reader (`retryCount: 0`); receipt, then polling `GET /api/lifecycle/:campaign` every 5 s for up to 2 min; errors by code; proof link per transaction.
- `[slug]/page.tsx`: the panel replaces the donate panel when the campaign is past LIVE or LIVE past its deadline.
- `messages/en.json`: `campaignPage.lifecycle.*` (plain words).
- `docs/guides/donors.md`: voting rules corrected to ADR-045 (7 days / 25 %, no silence = yes; 1 hour on the test network) and a "How to vote, or get your money back" section.

### Deviations
- "My donations" page and the votes-waiting badge are a separate PR (3b) to keep this one reviewable.
- The donors guide still said 24 h / 50 % — corrected here (not a whitepaper change).

### Test results (this session)
- `vitest run src/__tests__/lifecycle-view.test.ts`: `Tests  6 passed (6)`
- E2E `e2e/lifecycle.spec.ts` (vote from the donating wallet, refund after failure, finish an ended campaign, visitor sees the vote without buttons, axe on the voting panel): first run `1 failed | 5 passed` — the address was shown lowercase; changed to checksummed (as wallets show it); then `6 passed (14.8s)`.
- Deliberate break: "Approve" sends `vote(false)` → `Expected - true / Received + false` in `a donor approves the next payment …`; restored.
- `pnpm --filter web test`: `Test Files  42 passed (42)`, `Tests  390 passed (390)`.
- `pnpm build` OK; full E2E: `142 passed (3.5m)`.
- typecheck, lint, design check: clean.

### Open questions / risks
- On dev, only Amoy campaigns that ended show the panel; the vote part needs a MILESTONES campaign with evidence submitted (033c builds the fundraiser side; until then `submitEvidence` is a Polygonscan call by the beneficiary).
- `release()` needs `setPayoutMode` by the operator (033d); until then a succeeded campaign shows "CHERR.IO now sets how the money is paid out".

## Part 3b — "My donations" and the votes-waiting count
### What I implemented
- `/[locale]/account/donations`: every campaign the user's addresses gave to, state chip, per address amount and next step; the steps link to the campaign's lifecycle panel (`#lifecycle`) — one place where actions are signed.
- Header: "My donations" in the account menu; "● N" on the account button and "My donations — N votes waiting" in the menu when a vote waits (from `GET /api/me/donations`).
- i18n `myDonations.*`, `ui.nav.myDonations`, `ui.nav.votesWaiting` (plural).

### Deviations
- Actions are not duplicated on "My donations"; it links to the campaign panel.
- The header count is not covered by E2E: the E2E server has no Privy app, so the header never shows a logged-in user there. The count itself (`votesWaiting`) is unit/DB-tested (part 2).

### Test results (this session)
- E2E `lifecycle.spec.ts` with the new "My donations" test: `8 passed (20.4s)`.
- Deliberate break: the refund link hidden (`action.kind === "refund" && Date.now() < 0`) → `Locator: getByRole('link', { name: 'Get your money back (15.00 USDC)' }) … element(s) not found`; restored. (A first attempt at the break did not compile — type narrowing — and was redone.)
- typecheck, lint, design check clean (the count uses `--wayfinding-text`, not cherry-500 on a light ground, ADR-041).
