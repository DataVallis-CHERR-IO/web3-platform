# TASK-014c-3 feedback — the Guardian decides Emergency Pool allocations under review
Status: DONE — Built (PR pending)

## What I implemented
- **Admin → Chain actions** (`/en/admin/guardian`) has a new first section **Emergency Pool allocations to decide**. It lists every `chain.allocation` in `NEEDS_REVIEW` (`loadAllocations(db, 100, { state: "NEEDS_REVIEW" })`, a new `state` option on the existing query). Each one shows the number, amount, sub-pool, campaign, why it is in review (turnout against the snapshotted quorum with the yes/no weight, or "nobody had voting weight") and the public reason (or "not stored on this platform").
- `PoolReviews.tsx` (client): a note of at least 10 characters, then **Send to the campaign** / **Return to the sub-pool**:
  1. `POST /api/admin/emergency-pool/allocations/:id/resolve` checks that the allocation is `NEEDS_REVIEW` in the indexed state, then writes `pool.allocation_resolve.requested` to `audit_log` (on the campaign when it is published here; `data` has the allocation id, the decision, the note, the pool, the campaign address and the amount).
  2. `sendResolveAllocation` (`lib/pool/allocation-client.ts`) simulates `resolveAllocation(id, approve)` through `/api/rpc` from the wallet holding `GUARDIAN_ROLE`, then sends it. `NotGuardian` and `AllocationNotNeedsReview` are named; a wrong network never reaches the wallet.
  3. `…/resolve/sent` links the hash (`pool.allocation_resolve.sent`). The request must belong to the same allocation.
- `components/admin/useRoleWallet.ts`: the role check that Admin → Emergency Pool already used, now for either role. `useOperator` became a thin wrapper.
- Routes: 404 for everyone except a platform admin with the second factor (the guard tests enumerate them automatically), 403 from another origin, 400 for a bad body or a short note, 404 for a non-numeric or unknown id, 409 `wrong_state`, 503 while the views are missing.
- Docs: technical 04 and 09, owner guide **v1.12** (§8: new table row and "Deciding an allocation under review"; the two "Planned" rows are replaced) with the PDF rebuilt, tasks README, spec status.

## Files changed
- `apps/web/src/lib/pool/resolve.ts`, `resolve-route.ts` (new): server checks and audit entries.
- `apps/web/src/app/api/admin/emergency-pool/allocations/[id]/resolve/route.ts`, `…/resolve/sent/route.ts` (new).
- `apps/web/src/lib/pool/allocation-client.ts`: `sendResolveAllocation`, `toResolveFailure`.
- `apps/web/src/lib/pool/public.ts`: `loadAllocations(…, { state })`.
- `apps/web/src/components/admin/useRoleWallet.ts` (new); `app/[locale]/admin/emergency-pool/useOperator.ts` (wrapper).
- `apps/web/src/app/[locale]/admin/guardian/page.tsx`, `PoolReviews.tsx` (new).
- `apps/web/messages/en.json`: `admin.guardian.poolReview.*`.
- Tests: `src/__tests__/pool-resolve.test.ts` (new); `e2e/admin-emergency-pool.spec.ts` (two tests).
- Docs listed above.

## Deviations from the task (and why)
- The admin overview tile "Campaigns waiting for a chain action" still counts campaigns only. Allocations in review show at the top of Chain actions; the tile can count them later if David wants that.
- The Guardian's note stays internal (audit log), like the campaign resolves. The public page shows "Sent by CHERR.IO" or "Returned by CHERR.IO" only.
- The optional email to contributors when a vote opens is still left for later (see 014c-2).

## New dependencies
- none

## How to verify
1. On dev, an allocation reaches review when its vote window (1 hour) ends with turnout under the quorum and someone presses **Count the vote**. A proposal from a sub-pool nobody gave to also gets there once counted.
2. https://dev.cherr.io/en/admin/guardian → **Emergency Pool allocations to decide** → connect the Guardian wallet (0x4326…B5a7) → write a note → **Return to the sub-pool** (or **Send to the campaign**) → one MetaMask confirmation → "Returned." / "Sent.".
3. A few minutes later the public Emergency Pool page shows **Returned by CHERR.IO** or **Sent by CHERR.IO**, and Admin → Audit log shows `pool.allocation_resolve.requested` / `.sent`.

## Test results
`pool-resolve.test.ts` (new, 5 tests) covers:
- the browser call: simulate then send for both decisions; `NotGuardian` → `not_guardian`, `AllocationNotNeedsReview` → `already_done`; a wrong network does not simulate; nothing reaches the wallet on a refusal;
- the NEEDS_REVIEW filter;
- the audit entries and their refusals on Postgres;
- the routes (404 / 403 / 400 / 409 / 200).

Result: `Tests  5 passed (5)`.

Deliberate break, with the NEEDS_REVIEW check disabled in `recordResolveIntent`:
```
   × … audits the decision before the wallet opens; refuses an allocation that is not NEEDS_REVIEW or unknown 33ms
   × … routes: 404 for anyone but a platform admin, 403 from another origin, 400 without a real note, 409 when not NEEDS_REVIEW 43ms
      Tests  2 failed | 3 passed (5)
```
Restored afterwards. Other runs:
- `admin-hidden` and `admin-mfa-guard` both pass and include the two new routes (route files are enumerated).
- `pnpm --filter web test`: `Test Files  77 passed (77)`, `Tests  614 passed (614)`.
- typecheck and lint clean.

E2E, after `pnpm build`, ran `admin-emergency-pool.spec.ts`, `emergency-pool.spec.ts` and `guardian.spec.ts`: `30 passed (1.3m)`. That run includes two new tests:
- the Guardian sees the item (amount, sub-pool, short campaign address, "Turnout 5% of the 25% needed (yes 1.00 USDC, no 0.00 USDC)"); the button stays disabled until the note is written; axe is clean; **Return to the sub-pool** sends `resolveAllocation(id, false)`, shows "Returned." and writes both audit entries;
- a wallet with only the Operator role sees "None of your connected wallets has the Guardian role." and the buttons stay disabled.

Full E2E: `262 passed (10.5m)`.

## Open questions / risks
- **Prod Gas Manager:** not needed. The Guardian signs from an external wallet and pays its own POL.
- The contract decides "Not sent": if the campaign stopped accepting money, approve returns everything to the sub-pool. The page and the owner guide say so.

## Suggested commit message
feat(pool): Guardian decides Emergency Pool allocations under review (TASK-014c-3)
