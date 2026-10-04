# TASK-033d feedback — admin / Guardian chain actions
Status: DONE — part 1 PR #83 (Deploy run 37212648342), part 2 PR #84 (Deploy run 37214386912), both live on dev.

Spec: `docs/tasks/TASK-033-voting-lifecycle.md` §033d. Contract: `packages/contracts/src/Campaign.sol` `setPayoutMode` / `freeze` / `resolve`.

## Part 1 — what I implemented (branch `feat/TASK-033d-guardian-api`)
- `lib/campaigns/lifecycle-client.ts`: `LifecycleAction` gains `setPayoutMode(mode)`, `resolve(approve)`, `freeze()`. Same simulate-through-`/api/rpc`-then-sign path as the donor and fundraiser actions. New failure codes `not_operator`, `not_guardian`, `individual_single`; `PayoutModeAlreadySet` / `CannotFreeze` / `CannotResolve` → `already_done`. `resolve` keeps its own refusal on a FROZEN campaign (it is the call meant for that state) instead of the generic `frozen`.
- `lib/admin/guardian.ts`:
  - `openChainActions(lc)` — mirrors the contract: `setPayoutMode` only `SUCCEEDED` without a mode; `resolve` only `NEEDS_REVIEW`/`FROZEN`; `freeze` only `LIVE`/`SUCCEEDED`/`PAYING`/`VOTING`/`NEEDS_REVIEW`.
  - `suggestPayoutMode` / `loadPayoutSuggestion` — individual → MILESTONES; the organisation's first deployed campaign → SINGLE (supervised); later campaigns: average rating ≥ 4.0 → SINGLE, below → MILESTONES; **not first and no rating yet → MILESTONES** (my reading — see open questions). Only a suggestion; the admin picks.
  - `loadGuardianQueue` — deployed campaigns waiting for an admin: SUCCEEDED without a payout mode, NEEDS_REVIEW, FROZEN (oldest end first). null without the indexer views.
  - `recordChainIntent` (step 1, before the wallet opens) checks the action against the indexed state and writes `chain.<action>.requested` with the note, state, round and contract to `audit_log`; `recordChainSent` (step 2) writes `chain.<action>.sent` with the transaction hash linked to the request. The note survives a cancel in the wallet; the chain stays the record of what happened.
  - `listChainActionLog` — the campaign's notes and transactions, newest first.
- API: `POST /api/admin/campaigns/:id/chain-actions` and `POST …/chain-actions/sent` (PLATFORM_ADMIN re-read from the DB, 404 for everyone else, origin check, zod). Notes 10–2,000 characters, required for `resolve` and `freeze`, optional for the payout mode. New refusal codes `not_deployed` (409), `wrong_state` (409), `chain_unavailable` (503) with texts in `admin.campaigns.errors`.
- `lib/campaigns/evidence.ts`: `listAdminEvidence(db, campaignId, address)` — every bundle with `privateFileId` per private file, for the audited `GET /api/admin/files/:id` (the public and fundraiser views do not get the field).

## Files changed (part 1)
- `apps/web/src/lib/campaigns/lifecycle-client.ts` — three admin actions, error mapping.
- `apps/web/src/lib/admin/guardian.ts` — new: rules, suggestion, queue, audited intent/sent, log.
- `apps/web/src/app/api/admin/campaigns/[id]/chain-actions/route.ts`, `…/sent/route.ts` — new routes.
- `apps/web/src/lib/campaigns/review.ts`, `review-route.ts` — three refusal codes; `chain_unavailable` → 503.
- `apps/web/src/lib/campaigns/evidence.ts` — `listAdminEvidence`.
- `apps/web/messages/en.json` — `campaignPage.lifecycle.errors.{not_operator,not_guardian,individual_single}`, `admin.campaigns.errors.{not_deployed,chain_unavailable,wrong_state}`.
- `apps/web/src/__tests__/guardian.test.ts` — new (8 tests); `lifecycle-client.test.ts` — admin actions and errors (+1 test).
- `docs/technical/04-web-app-and-auth.md`, `09-status-and-roadmap.md` — part 1 rows; TASK-033c part 3 flipped to Live on dev (PR #82, Deploy run 37206528284).

## Deviations
- The spec says "`freeze` with a reason": `Campaign.freeze()` takes no argument, so the reason is the audit note only (no contract change — "Must not touch").
- There is no `unfreeze()`; unfreezing is `resolve(true)` on a FROZEN campaign (restores the previous state; a vote gets its frozen time back). The admin page (part 2) will label it so.

## New dependencies
- none

## Test results (part 1, local sandbox, 2026-10-04)
```
$ pnpm --filter web test
 Test Files  45 passed (45)
      Tests  411 passed (411)
$ pnpm --filter web lint      → eslint . (no output, exit 0)
$ pnpm --filter web typecheck → tsc --noEmit (no output, exit 0)
```
Deliberate breaks (then restored, `Tests 8 passed (8)`):
1. `FREEZABLE` with `"FAILED"` added → `× openChainActions … → expected [ 'LIVE', 'SUCCEEDED', 'FAILED', …(3) ] to deeply equal [ 'LIVE', 'SUCCEEDED', 'PAYING', …(2) ]`
2. The individual-SINGLE refusal disabled → `× refuses an action the indexed state does not allow … AssertionError: expected { status: 200, …(1) } to deeply equal { status: 409, …(1) }`
```
      Tests  2 failed | 6 passed (8)
```

## Open questions / risks
- **Payout suggestion for a later campaign with no rating yet:** I suggest MILESTONES (careful default). The spec only covers "first campaign → SINGLE supervised" and "rating ≥ 4.0 / < 4.0". David may prefer SINGLE; it is one line in `suggestPayoutMode`.
- Ratings (`app.ratings`) have no writer yet (TASK-015), so on dev every organisation is "first campaign" or "no rating".

## Suggested commit message
feat(web): admin chain actions — payout mode, Guardian resolve/freeze API (TASK-033d part 1)

---

## Part 1 merged and deployed
- PR #83 squash-merged (`796fd23`), CI green (Lint/Typecheck/Test & Build, E2E, image builds); Deploy run 37212648342 success.

## Part 2 — what I implemented (branch `feat/TASK-033d-guardian-ui`)
- `components/admin/AdminWallets.tsx` — the admin's signing wallets (Privy external wallets, or the E2E wallet with APP_ENV=local), extracted from `ContractConsole.tsx`, which now uses it (no behaviour change; its E2E spec passes).
- Admin campaign page (`/en/admin/campaigns/[id]`, `DEPLOYED`): `ChainActions.tsx` (server) — section **On the blockchain — CHERR.IO actions**: indexed state, payout plan, raised, paid out, payments made, and for a vote the turnout vs. the campaign's own quorum and the yes share; the fundraiser's evidence per round (private files via the audited `GET /api/admin/files/:id`); **Notes and transactions**. `GuardianPanel.tsx` (client): connected wallets with Operator/Guardian roles (read through `/api/rpc`), **Set the payout plan** (suggestion preselected, one payment disabled for individuals), **Decide the vote** / **Frozen campaign** (`resolve`, note required; "Unfreeze — continue where it stopped" on FROZEN), **Freeze the campaign** (note + confirmation). Each action: note → API, wallet signs (`sendLifecycle`), hash → API, receipt, page refresh.
- `/en/admin/guardian` — **Chain actions** queue; tile + button on `/en/admin`.
- Owner guide **v1.2**: §8 rewritten (actions now on the admin pages, step by step, what each call does on the contract); change log line; PDF rebuilt (`dist/CHERR.IO-Contracts-Owner-Guide-v1.2.pdf`, 16 pages; v1.1 removed).
- Technical 04/09: part 1 Live on dev, part 2 Built.

## Files changed (part 2)
- `apps/web/src/components/admin/AdminWallets.tsx` (new), `apps/web/src/app/[locale]/admin/contracts/ContractConsole.tsx` (uses it)
- `apps/web/src/app/[locale]/admin/campaigns/[id]/ChainActions.tsx`, `GuardianPanel.tsx` (new), `page.tsx` (renders the section)
- `apps/web/src/app/[locale]/admin/guardian/page.tsx` (new), `apps/web/src/app/[locale]/admin/page.tsx` (tile + link)
- `apps/web/messages/en.json` — `admin.guardian.*`, `admin.tiles.chainActions`, `admin.guardianLink`
- `apps/web/e2e/guardian.spec.ts` (new, 2 tests × 2 viewports)
- `docs/guides/owner/contracts-owner-guide.md`, `README.md`, `dist/…-v1.2.pdf`; `docs/technical/04`, `09`; this file

## Test results (part 2, local sandbox, 2026-10-04)
```
$ pnpm check:design            → Design check passed — no violations found.
$ pnpm build                   → ⚠ Compiled with warnings in 97s (… /[locale]/admin/guardian …)
$ CI=1 pnpm exec playwright test e2e/guardian.spec.ts --retries=0
  4 passed (16.3s)
$ CI=1 pnpm exec playwright test --retries=0      (whole suite)
  152 passed (4.2m)
```
First runs failed on my test, not the code: the second campaign of the same organisation is not "first", so the suggestion is "milestones — not the first campaign and no rating yet" (the test now expects that and picks one payment instead), and `getByRole("radio", { name: "One payment" })` also matched "Three mileST**ONE PAYMENT**s" (now `exact: true`).

Deliberate break: the Reject button sending `resolve(true)` → after a rebuild
```
    - Expected  - 1
    + Received  + 1
    -       false,
    +       true,
  1 failed
```
Restored, rebuilt → `4 passed (16.3s)`.

## How David checks it on dev (after part 2 is deployed)
1. https://dev.cherr.io/en/admin → tile **"Campaigns waiting for a chain action"** and button **"Chain actions"**.
2. https://dev.cherr.io/en/admin/guardian → a succeeded Amoy campaign without a payout plan shows **"Set the payout plan"**.
3. Open it, connect MetaMask (0x4326…B5a7): the list shows **"0x4326…: Operator, Guardian"**. Pick **"Three milestone payments"** → **Set the payout plan** → MetaMask → "Sent…". After about a minute the row "Payout plan" says **"Three milestone payments"** and the campaign leaves the queue. This also unblocks the real-data check of 033c (release payment 1 → evidence → vote).

Part 2 merged (`250f619`), CI green, Deploy run 37214386912 success.

## Decided (David, 2026-10-04) — ADR-049
- Vote points stay in **both** balances; a later campaign without a rating is suggested **MILESTONES**; the 1,000 points = 1 CHR rate must be recalculated for the 85.1 M supply before Phase 2.
