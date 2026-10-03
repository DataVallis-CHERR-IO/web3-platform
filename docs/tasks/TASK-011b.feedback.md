# TASK-011b feedback — donation from a wallet
Status: DONE — Live on dev (PR #55, Deploy run 37133801446 green, 2026-10-03). First real donation on dev with Amoy USDC: David

Spec: `docs/tasks/TASK-011-campaign-pages-donations.md` §011b. Branch `feat/TASK-011b-wallet-donation`.

## What I implemented
- **Donate panel** in the campaign page's sticky panel while the campaign is LIVE on chain and before its deadline:
  - amount field in EUR (quick amounts €10 / €25 / €50 / €100, default €25), converted to USDC with the display rate for EUR (`app.fx_rates`, ADR-040), `bigint`, rounded down;
  - without a usable EUR rate the field is in USDC;
  - minimum €1 and 1 USDC ("The minimum donation is €1.");
  - above the remaining target: "This campaign needs only N USDC more, so only that will be taken";
  - "Details" with the exact USDC amount, the rate, the minimum and the POL-fee note.
- **Failure preference:** "Refund to me" (default) or "Send it to the Emergency Pool" with an optional theme (seeded sub-pools that exist in `chain.pool`; general pool = 0).
- **Wallet:** Privy `useWallets()` (external wallet first, else the embedded one). Logged out → "Log in to donate" opens the Privy login. No wallet → a notice. Without Privy → "Donating is not available right now."
- **Transaction** (`lib/campaigns/donate-client.ts`, viem over the wallet's EIP-1193 provider):
  1. switch chain;
  2. check the chain id, `state() == LIVE` and the deadline;
  3. read `config()`, `usdc()`, `minDonation()` and `remaining()`;
  4. read the USDC balance and allowance;
  5. `approve(campaign, exact)` only if the allowance is lower, and wait for it;
  6. `donate(amount, pref, subPoolId)`, wait for the receipt, show a ProofLink and refresh the page.
  - Minimum tip of 30 gwei (`polygonFees`).
- **Errors** map to fixable messages: wrong network, campaign ended, below minimum, not enough USDC (on a testnet with a link to Circle's faucet), no POL for the fee, cancelled in the wallet, timeout (the tx link stays visible), rejected by the chain.
- **"Your donation"** box: `GET /api/donations/[campaign]` (session only, the user's own rows) → total and current preference. "Change" calls `setPreference` from the wallet that donated.
- **Mobile:** a bottom bar "Donate to this campaign" → `#donate`.
- **Fixed on the way:** on a phone the converted key figure ("≈ $11,680.00 (11,680.00 USDC)", `whitespace-nowrap`) widened the campaign page to 508 px at a 390 px viewport. That was a TASK-011a bug.
  - `.ch-campaign-top` is now `minmax(0, 1fr)` on narrow screens, and amounts in the panel may wrap.
  - The E2E test now checks for no sideways scroll.

## Files changed
- `apps/web/src/lib/campaigns/donate.ts` — amount rules (parse EUR/USDC, EUR→USDC at the display rate, minimum, clip; `send` vs `usdc` taken).
- `apps/web/src/lib/campaigns/donate-client.ts` — `donate`, `changePreference`, `waitForTx`, `approvalAmount` (exact), `toDonateFailure`.
- `apps/web/src/components/campaigns/DonatePanel.tsx` — panel, wallet selection, "Your donation".
- `apps/web/src/app/api/donations/[campaign]/route.ts` — the user's own donations to one campaign.
- `apps/web/src/lib/campaigns/public.ts` — `listDonationThemes`, `listMyDonations`.
- `apps/web/src/app/[locale]/campaigns/[slug]/page.tsx` — panel props (chain, remaining, EUR rate, themes, explorer), bottom bar.
- `apps/web/messages/en.json` — `campaignPage.donate.*`, `campaignPage.yourDonation.*`, `pool.*` (the sub-pool names the seed's `name_key`s point to; they were missing).
- `packages/ui/src/styles/components.css` — `.ch-donate*`, mobile bottom bar, panel wrapping fix.
- Tests: `src/__tests__/donate-amount.test.ts` (23), `src/__tests__/donate-client.test.ts` (21), `src/__tests__/public-campaigns.test.ts` (+3), `e2e/donate.spec.ts` (2 × 2 viewports).
- Docs: `docs/technical/03`, `04` (§4.1 donate panel, API row), `07`, `09`, `docs/tasks/README.md`, screenshots in `docs/tasks/screenshots/TASK-011b/`.

## Deviations from the task (and why)
- **The approve covers what will be taken, not the typed amount.** When the amount is clipped, `donate()` gets the typed amount, because the contract checks `minDonation` against the amount passed. So the last few cents of a campaign can still be given, and the transfer can never exceed the allowance.
- **Test wallet hook.** Playwright cannot drive Privy. The panel accepts an injected EIP-1193 wallet on `window.__cherrioE2eWallet`, but only when `APP_ENV=local`, which is never deployed. It is documented in 04 and 07.
- **Size:** about 830 lines of production code plus messages and CSS, and about 700 lines of tests. That is above the ~800-line guide; the tests are most of it. Splitting the panel from its transaction logic would have shipped a button that does nothing.
- **`docs/guides/donors.md` not updated yet.** The spec says to update it when donating works on dev, which needs a real donation with Amoy USDC.

## New dependencies
- none (viem's `erc20Abi`; Privy and viem were already there)

## How to verify
1. `pnpm --filter web test` → 244 passed.
2. `cd apps/web && pnpm build && CI=1 pnpm exec playwright test` → 124 passed.
3. On dev, after the deploy:
   1. Log in with MetaMask holding Amoy USDC (Circle faucet) and a little POL.
   2. Open a LIVE campaign, `https://dev.cherr.io/en/campaigns/<slug>`.
   3. The panel reads "Give to this campaign". Click €10 and Donate.
   4. Confirm two wallet prompts: the approve for the exact amount (MetaMask shows e.g. "11.734 USDC", not "unlimited"), then the donation.
   5. Expect "Thank you! Your donation is recorded on the blockchain" with "See your transaction ↗".
   6. Within a minute the row appears under "Every donation, on the blockchain", and "Your donation" shows the total.

## Test results (real output, this session)
New unit tests:
```
 ✓ src/__tests__/donate-client.test.ts (21 tests) 61ms
 ✓ src/__tests__/donate-amount.test.ts (23 tests) 10ms
 Test Files  2 passed (2)
      Tests  44 passed (44)
```
Read model + API:
```
 ✓ src/__tests__/public-campaigns.test.ts (14 tests) 930ms
```
Full web suite:
```
 Test Files  30 passed (30)
      Tests  244 passed (244)
```
**Deliberate break** — `approvalAmount()` returns `2^256-1` (unlimited approve):
```
   × donate (TASK-011b) > approves the exact amount, then donates with the preference 24ms
     → expected { …(4) } to match object { …(2) }
   × donate (TASK-011b) > clips the approval to remaining() but passes the typed amount to donate() 9ms
     → expected [ …(2) ] to deeply equal [ …(2) ]
   × donate (TASK-011b) > never asks for an unlimited allowance 1ms
     → expected 11579208923731619542357098500868790785…n to be 12000000n // Object.is equality
```
Restored → `Tests  21 passed (21)`.

E2E, `donate.spec.ts` on both viewports, then the full suite after a fresh build:
```
  4 passed (13.0s)
  124 passed (3.1m)
```
Lint, typecheck and `pnpm check:design` were clean ("Design check passed — no violations found.").

Note on E2E in a reused local database: one earlier full run failed `display-currency.spec.ts` because `app.fx_rates` still held the EUR row from a previous run. The fx module then kept a 30 s in-memory copy without CHF. The spec passed alone, and the full suite passed after `delete from app.fx_rates`. This existed before (every spec that writes rates leaves them). CI starts from an empty database.

## Open questions / risks
- **Embedded-wallet donors need POL** for gas until TASK-011c adds sponsorship. The panel says so in "Details" and maps "insufficient funds" to a fixable message.
- **"Remaining"** in the panel comes from the indexer (up to a minute behind). The transaction re-reads `remaining()` from the chain, so the clip is always correct on chain.
- **Sub-pool themes** appear only once the operator has created sub-pools on chain and the DB seed has run on dev. Until then only "Wherever it is needed most" (pool 0) is offered, which is correct.

## Docs updated
`docs/technical/03-data-and-indexer.md`, `04-web-app-and-auth.md`, `07-delivery-and-quality.md`, `09-status-and-roadmap.md`; `docs/tasks/README.md`.

## Suggested commit message
feat(web): donate from a wallet — EUR amount, failure preference, exact approve + donate (TASK-011b)
