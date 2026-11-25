# donate-box-loading feedback
Status: DONE

## What I implemented
- Found by the testnet agents (TASK-061d): in crew runs 45624222186 and 45628316062 the observation model reported that, right after Back/Forward, the donate box said "Donating is not available right now. Please try again later." Cause: `WithDonorWallet` (`apps/web/src/components/wallet/DonorWallet.tsx`) returned `unavailable` while Privy was still loading (`isLoading`), which the donate box and the Emergency Pool give panel show as an outage. Every page view has this moment for a few seconds.
- Fix: while Privy loads the state is `preparing` ("Preparing your wallet…" / "Preparing your CHERR.IO wallet…"); `unavailable` stays for a page without Privy and without the E2E wallet.

## Files changed
- `apps/web/src/components/wallet/DonorWallet.tsx` — loading → `preparing`.
- `apps/web/src/__tests__/donor-wallet-loading.test.tsx` — new (2 tests).

## Deviations
- Not changed: `lifecycle-signers.ts` has the same pattern for the vote/claim panels; those panels are seen only by donors after donating, and their "unavailable" wording differs — left for when the agents reach voting (061e).

## Test results (this session)
- New test → `Tests 2 passed (2)`; deliberate break (loading → `unavailable` again) → `Tests 1 failed | 1 passed (2)` ("is preparing, not unavailable"); restored.
- `pnpm --filter web test` → `Test Files 82 passed (82)`, `Tests 645 passed (645)`; typecheck, lint clean; `pnpm check:design` passed.
- NOT RUN: E2E (no Privy in E2E; the E2E wallet path is unchanged).

## docs/technical chapters updated
- none — wording of a transient state only.
