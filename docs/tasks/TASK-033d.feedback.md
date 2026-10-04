# TASK-033d feedback — admin / Guardian chain actions
Status: PARTIAL — part 1 (logic + API) done; part 2 (admin pages, E2E, owner guide) follows in the next PR.

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
