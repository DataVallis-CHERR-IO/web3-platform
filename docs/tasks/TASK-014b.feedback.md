# TASK-014b feedback — give to a sub-pool
Status: DONE (Built, PR pending)

## What I implemented
- **"Give to this pool"** under every sub-pool card on `/en/emergency-pool` (only when the environment has an EmergencyPool): a folded form, amount in USDC (≥ 1), then `approve(pool, exact amount)` when the allowance is lower and `EmergencyPool.donate(poolId, amount)`. A CHERR.IO wallet (smart account) sends both as one sponsored user operation. Steps, transaction link, the same error messages as campaign donations (minimum worded for USDC), faucet link on the test network.
- `lib/pool/give-client.ts`: checks chain, `poolExists(poolId)`, `PlatformConfig.minDonation`, USDC balance before anything is sent; never an unlimited approve (`approvalAmount`).
- **Shared wallet choice:** `components/wallet/DonorWallet.tsx` (`WithDonorWallet`, `WalletState`, `withTimeout`, `CIRCLE_FAUCET`) extracted from `DonatePanel.tsx` without behaviour change; both the campaign donate panel and the gift form use it.
- Docs housekeeping: stale statuses in `docs/tasks/README.md` (TASK-008, 011, 029, 057 → Live on dev); labels of PR #203 flipped to Live on dev.

## Files changed
- `apps/web/src/components/wallet/DonorWallet.tsx` (new), `apps/web/src/components/campaigns/DonatePanel.tsx` (uses it; −102 lines).
- `apps/web/src/lib/pool/give-client.ts`, `apps/web/src/components/pool/GivePanel.tsx` (new), `apps/web/src/app/[locale]/emergency-pool/page.tsx`, `apps/web/messages/en.json` (`emergencyPool.give.*`), `packages/ui/src/styles/components.css` (`.ch-pool-give`).
- Tests: `apps/web/src/__tests__/pool-give-client.test.ts` (new, 5), `apps/web/e2e/emergency-pool.spec.ts` (own wallet, smart account, axe with the form open; the zero-amount test now waits for the 30-second rate cache like `display-currency.spec.ts`).
- Docs: technical 04, 09; guide `donors.md`; tasks README; spec status.

## Deviations from the task (and why)
- The amount is entered in USDC only (no EUR/USD field like campaigns): a sub-pool has no goal currency; USDC is what the contract takes.
- The page is not refreshed after a gift: the indexer on dev runs every 2 minutes, so the success message says the figures update after the next blockchain update.
- Unrelated flake found and fixed: the zero-amount E2E (PR #203) failed once because the server's 30 s rate cache did not yet hold the POL rate.

## New dependencies
- none

## How to verify
1. https://dev.cherr.io/en/emergency-pool (logged in) → under "General" open **Give to this pool** → "Your gift stays in this sub-pool…", amount 10, button **Give to General**.
2. With MetaMask on Amoy: two confirmations (amount, then gift); with the CHERR.IO wallet one step without a fee (needs Alchemy sponsorship — capped until 1 November). Then "Thank you — 10.00 USDC went to General." and a transaction link; a few minutes later "Given with a vote" and "Contributors" go up.

## Test results
`pool-give-client.test.ts` + `donate-client.test.ts`: `Tests  37 passed (37)`.
Deliberate break — approve for twice the amount on the own-wallet path:
```
   × give to a sub-pool (TASK-014b) > approves exactly the amount to the pool, then donate(poolId, amount) 24ms
     → expected [ …(2) ] to deeply equal [ …(2) ]
```
Restored. `pnpm --filter web test`: `Tests  597 passed (597)`. typecheck, lint clean; `check:design` passed.
E2E `emergency-pool.spec.ts` + `donate.spec.ts`: first run `1 failed, 19 passed` (the POL rate cache flake above); after the fix `emergency-pool.spec.ts --repeat-each=2`: `20 passed`. Full suite: `252 passed (7.5m)`.
Screenshots of the open form at 1440 and 390 checked (temporary spec).

## Open questions / risks
- **Prod Gas Manager policy:** the contract allow-list of the prod Privy/Alchemy policy must include `EmergencyPool.donate` (and USDC `approve` to the pool) or CHERR.IO-wallet gifts are refused — added to HANDOFF for the launch runbook.

## Suggested commit message
feat(pool): give to a sub-pool from the wallet (TASK-014b)
