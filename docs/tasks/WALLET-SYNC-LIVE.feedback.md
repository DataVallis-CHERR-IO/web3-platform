# Live wallet sync on the account page (feedback)
Status: DONE — follow-up to TASK-011c from David's test on dev (2026-10-03).

## What David saw
- After a first email login, "Linked wallets" stayed empty until he reloaded: Privy creates the embedded wallet seconds after login, after our session already exists, and nothing re-synced.
- No "Donation account" row even after a reload (smart account missing). Root cause under investigation with David (Privy dashboard vs. code) — this PR makes the sync robust either way.

## What I implemented
- `lib/auth/wallet-sync.ts`: `missingWalletAddresses(linkedAccounts, stored, smartClientAddress)` and `WALLET_SYNC_DELAYS_MS` (0, 2, 5, 10, 20 s).
- `PrivyClientProvider`: `WalletSync` replaces `SmartAccountSync`. It watches every wallet + smart-wallet address Privy reports in the browser (and the smart-account client's address) and calls `POST /api/auth/wallets/sync` while one is missing, with spaced tries; tries start again when Privy links the smart account (`privyUser.smartWallet` changes). The server still reads the Privy user record itself.
- Account page: "Your wallet is being created…" (no address yet) and "Your donation account is being prepared…" (smart-account client present, not yet stored) notices; rows appear without a reload.

## Files changed
- `apps/web/src/lib/auth/wallet-sync.ts` (new), `apps/web/src/components/auth/PrivyClientProvider.tsx`, `apps/web/src/app/[locale]/account/AccountClient.tsx`, `apps/web/messages/en.json`
- `apps/web/src/__tests__/wallet-sync.test.ts` (new, 5 tests)
- `docs/technical/04-web-app-and-auth.md` §4.2

## Deviations
- none

## Test results (this session)
```
$ pnpm exec vitest run src/__tests__/wallet-sync.test.ts
      Tests  5 passed (5)
```
Deliberate break — `smart_wallet` accounts ignored:
```
   × missingWalletAddresses > reports a linked smart wallet missing from the stored addresses 7ms
      Tests  1 failed | 4 passed (5)
```
Restored → `Tests  5 passed (5)`.
```
$ pnpm --filter='!@cherrio/contracts' lint       → apps/web lint: Done
$ pnpm --filter='!@cherrio/contracts' typecheck  → apps/web typecheck: Done
$ pnpm --filter web test
 Test Files  33 passed (33)
      Tests  264 passed (264)
$ pnpm build → exit 0
$ CI=1 pnpm exec playwright test e2e/auth-nav.spec.ts e2e/donate.spec.ts e2e/a11y.spec.ts --retries=0
  92 passed (1.7m)
```
The live Privy behaviour (timing of wallet creation and smart-wallet linking) cannot run here (no Privy app in tests) — proof is David's next first login on dev.

## Suggested commit message
fix(web): account page picks up new wallets without a reload
