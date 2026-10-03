# TASK-011c feedback — smart account + sponsored gas
Status: DONE (code, tests, docs). Proof on dev with a real sponsored donation: pending David (needs Amoy USDC in the smart account).

Spec: `docs/tasks/TASK-011-campaign-pages-donations.md` §011c. Privy dashboard part (smart wallets "Alchemy", Amoy bundler + paymaster + Gas Manager policy) done by David 2026-10-03.

## What I implemented
- `SmartWalletsProvider` around the app (`PrivyClientProvider`); bundler/paymaster/policy stay in the Privy dashboard — **no new env var**.
- Donate panel: a user without an external wallet donates from the **smart account** of the CHERR.IO (embedded) wallet. `donateWithSmartAccount()` runs the same checks as 011b (refactored into a shared `prepareDonation()`), against the smart-account address, then sends `[approve(exact)?, donate]` as **one user operation** through Privy's smart-wallet client. `setPreference` goes the same way.
- Texts: one-step progress text, "No network fee: CHERR.IO pays it for wallets created here.", "Preparing your wallet…", `sponsorship_refused`, `insufficient_usdc_smart` (names the donation-account address; faucet link on testnet).
- Sync: Privy's `smart_wallet` linked account → `SMART_ACCOUNT` in `app.user_addresses` (server reads Privy; browser address never trusted). `SmartAccountSync` re-syncs when the client's smart account is missing from the user's addresses (3 tries, 5 s apart).
- Account page: badge "Donation account" + hint where to send USDC; the embedded signer says not to send money there.
- External wallets: unchanged (011b path).

## Files changed
- `apps/web/src/lib/campaigns/donate-client.ts` — `prepareDonation`, `donationCalls`, `donateWithSmartAccount`, `SendCalls`, `changePreference(..., sendCalls?)`, `sponsorship_refused` mapping (nested error text).
- `apps/web/src/components/campaigns/DonatePanel.tsx` — wallet choice (external → smart account → embedded fallback after 8 s), smart path, texts.
- `apps/web/src/components/auth/PrivyClientProvider.tsx` — `SmartWalletsProvider`, `SmartAccountSync`.
- `apps/web/src/lib/auth/user-helpers.ts` — `smart_wallet` → `SMART_ACCOUNT`.
- `apps/web/src/app/[locale]/account/AccountClient.tsx` — badges/hints.
- `apps/web/messages/en.json` — new texts.
- `apps/web/package.json`, `pnpm-lock.yaml` — `permissionless`.
- Tests: `src/__tests__/donate-client.test.ts` (+11), `src/__tests__/user-helpers-wallets.test.ts` (new, 2), `e2e/donate.spec.ts` (+1 scenario; fake wallet `sendCalls`).
- Docs: `docs/technical/04` (§4.2 new, §5.1), `05` (Privy dashboard config, no env var), `06` (gas sponsorship limits, open item for prod), `07` (tests), `09` (status), `docs/guides/donors.md` (Option C), `docs/tasks/README.md`.

## Deviations from the task (and why)
- **No non-sponsored fallback when sponsorship is refused.** The spec says "offer the non-sponsored path only if the account holds POL". A smart account paying its own gas needs a second Privy client without the paymaster, which Privy's provider does not expose; and a CHERR.IO user practically never holds POL. The panel says plainly that nothing was taken and to try later or use an own wallet. Can be added if David wants it.
- **USDC already in the embedded signer is not used.** The donor address is now the smart account; USDC must be sent there (account page and the error message say so). On dev only test USDC is affected.
- **Embedded-wallet fallback after 8 s** if no smart-account client appears (smart wallets not enabled for that Privy app, e.g. a new prod app): the panel then uses the embedded wallet directly (011b path, needs POL) instead of hanging.

## New dependencies
- `permissionless@0.2.57` (MIT) — required peer of `@privy-io/react-auth/smart-wallets`.

## How to verify (David, on dev after deploy)
1. Log in on https://dev.cherr.io/en with **email or Google** (not MetaMask).
2. Open https://dev.cherr.io/en/account → "Linked wallets": a row with the badge **"Donation account"** appears within ~15 s (reload once if needed). Copy that address.
3. Send Amoy USDC to it: https://faucet.circle.com/ → Polygon PoS Amoy → paste the address.
4. Open a live campaign under https://dev.cherr.io/en/campaigns, "Details" must say **"No network fee: CHERR.IO pays it for wallets created here."**, click **Donate**: **one** Privy confirmation, then "Thank you!" with a transaction link. On amoy.polygonscan.com the transaction is a user operation (EntryPoint) and the donor in the list is the donation-account address.
5. If the policy refuses: "The free network fee is not available right now. Nothing was taken." → check the Gas Manager policy limits in Alchemy.

## Test results (this session, 2026-10-03)
```
$ pnpm exec vitest run src/__tests__/donate-client.test.ts
      Tests  32 passed (32)
```
Deliberate break 1 — one user operation per call (`for (const c of donationCalls(...)) txHash = await sendCalls([c])`):
```
   × donateWithSmartAccount (TASK-011c) > sends approve(exact) + donate as ONE batch and signs nothing through the wallet provider 13ms
   × donateWithSmartAccount (TASK-011c) > clips the approval to remaining() but passes the typed amount to donate() 6ms
      Tests  2 failed | 30 passed (32)
```
Deliberate break 2 — sponsorship mapping removed:
```
   × donateWithSmartAccount (TASK-011c) > reports a refused sponsorship plainly 14ms
   × toDonateFailure > Error: UserOperation reverted: AA21 didn't pay prefund → sponsorship_refused 1ms
   × toDonateFailure > Error: Gas Manager policy rejected the request → sponsorship_refused 1ms
      Tests  3 failed | 29 passed (32)
```
Restored → `Tests  32 passed (32)`.

```
$ pnpm exec vitest run src/__tests__/user-helpers-wallets.test.ts
      Tests  2 passed (2)
```
Deliberate break 3 — smart wallet stored as `EXTERNAL`:
```
   × extractWalletsFromPrivyUser > stores the smart wallet as SMART_ACCOUNT next to its embedded signer 10ms
      Tests  1 failed | 1 passed (2)
```
Restored → `Tests  2 passed (2)`.

```
$ pnpm --filter='!@cherrio/contracts' lint        → packages/ui, apps/indexer, apps/web lint: Done
$ pnpm --filter='!@cherrio/contracts' typecheck   → apps/indexer, apps/web typecheck: Done
$ pnpm --filter web test
 Test Files  31 passed (31)
      Tests  257 passed (257)
$ pnpm check:design                               → Design check passed — no violations found.
$ pnpm build                                      → exit 0
$ CI=1 pnpm exec playwright test e2e/donate.spec.ts --retries=0
  6 passed (20.0s)
$ CI=1 pnpm exec playwright test --retries=0      (full suite)
  126 passed (3.7m)
```
Contracts and indexer: not touched — NOT RUN locally (CI skips them by changed areas).

## Open questions / risks
- The sponsored path has never run against the real Alchemy bundler/paymaster — only against a mocked `sendCalls`. Proof = David's step 4 above.
- Privy may show its own confirmation modal for the user operation (dashboard setting) — that is the "one confirmation".
- Gas Manager policy limits and (for mainnet) the contract allow-list are dashboard settings David owns; documented in `06-security.md`.

## Suggested commit message
feat(web): TASK-011c — donate from a smart account in one sponsored step
