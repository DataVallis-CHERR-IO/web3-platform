# TASK-036b feedback — card onramp on dev (sandbox)
Status: DONE (code) — David's sandbox run with the test card on dev still open

Spec: `docs/tasks/TASK-036-add-money.md` (part 036b), ADR-051.

## Context (David, 2026-10-07)
- Stripe Onramp application **approved**.
- Privy dashboard → Funding → **Card onramps** switched on for the testnet app. Privy now lists Stripe, the Meld aggregator (Transak, Swapped, … — needs "Configure" + a KYB with Meld for more currencies) and MoonPay. Privy's note: *"Without additional verification, client-side onramps support USD and EUR with Stripe and AUD and BRL with MoonPay."*
- Coinbase is no longer a separate option in Privy's list; ADR-051's "Stripe + Coinbase, Transak as fallback" becomes "Stripe; Meld (Transak) or MoonPay only if added later". No ADR text change — the decision (card through Privy's funding flow, top up then donate, minimum 20 €) is unchanged.

## What I implemented
- `config/deploy.dev.yml`: `FUNDING_ONRAMP: sandbox` (clear env; the next Deploy applies it).
- `lib/funding/topup.ts`:
  - `FundingMode` `onramp` carries `faucet: boolean` — true on a test network. Before, `sandbox` replaced the faucet; on dev that would have removed the only way testers get USDC (the sandbox delivers nothing).
  - `TOPUP_FIAT_CURRENCIES = ["eur", "usd"]` (was EUR, USD, GBP, CHF): the currencies Privy's client-side Stripe onramp takes without extra KYB.
- `components/funding/AddMoney.tsx`: faucet block extracted (`Faucet`) and shown below the card form when `mode.faucet`.
- `packages/ui/src/styles/components.css` `.ch-addr button`: `white-space: nowrap; flex: none` — at 390 px the long address squeezed the "Copy" button to "CO / PY" (seen in the screenshot, existed since TASK-036a).

## Files changed
- `config/deploy.dev.yml` — `FUNDING_ONRAMP: sandbox`.
- `apps/web/src/lib/funding/topup.ts`, `apps/web/src/components/funding/AddMoney.tsx` — see above.
- `packages/ui/src/styles/components.css` — copy button on one line.
- `apps/web/src/__tests__/funding-topup.test.ts` — mode table with `faucet`, currencies EUR + USD.
- `apps/web/src/__tests__/add-money.test.tsx` (new, 3) — renders the box per mode with mocked Privy/next-intl/ui; checks the options handed to `addFunds`.
- Docs: `docs/technical/04`, `05`, `09`; `docs/guides/donors.md`.

## Deviations
- Spec says "Enable providers (Stripe, Coinbase)": done by David in Privy; Coinbase is not offered there any more (see Context).
- Faucet kept next to the sandbox (spec's mode table had `faucet` only when not `sandbox`) — reason above.
- Left out on purpose: balance next to "Add money" and refresh after funding (spec "optional"): on dev the sandbox delivers nothing, so it could not be tested; worth doing only with real funding on prod.

## New dependencies
- none

## How to verify
1. `pnpm --filter web test` → 519 passed.
2. On dev after the Deploy (David): https://dev.cherr.io/en/account (logged in with email → CHERR.IO wallet) → box **"Add money"**: amount field "Amount" (EUR), the notice "Test mode: no card is charged and no USDC arrives. Use the test card 4242 4242 4242 4242.", the button **"Add money with a card"**, and below it the faucet text + "Get free test USDC". Click the button → Privy's window with Stripe; pay with 4242 4242 4242 4242, any future date, any CVC → the box shows "submitted"; no USDC arrives (sandbox).

## Test results
Unit (local):
```
 ✓ src/__tests__/funding-topup.test.ts (5 tests) 10ms
 ✓ src/__tests__/add-money.test.tsx (3 tests) 259ms
      Tests  8 passed (8)
```
Deliberate break 1 — `fundingMode` sandbox returns `faucet: false`:
```
   × fundingMode > faucet on a test network, the onramp only when switched on, sandbox wins everywhere and keeps the faucet on a test network 9ms
      Tests  1 failed | 7 passed (8)
```
Deliberate break 2 — `AddMoney` never renders the faucet below the form:
```
   × AddMoney > test network with the sandbox: card form, sandbox notice and the faucet below it 215ms
     → Unable to find an accessible element with the role "link" and name `/faucetLink/`
```
Both restored. Whole web suite: `Test Files 60 passed (60) / Tests 519 passed (519)`. `pnpm check:design`: "Design check passed — no violations found." Typecheck and lint clean.

Screenshots (temporary Playwright spec, not committed; local build started with `FUNDING_ONRAMP=sandbox`, Account page, 1440 and 390): the box shows the faucet below the card part. E2E has no Privy app, so the card part reads "Adding money is not available right now. Reload the page." there — the real form is covered by `add-money.test.tsx` and by David's run on dev. 390 px before the CSS fix: "CO / PY" on two lines; after: one line.

## Open questions / risks
- The sandbox run itself (Privy window, Stripe test card) cannot run in the sandbox here or in E2E — David checks it on dev.
- uat: `FUNDING_ONRAMP` not set (faucet only). Prod: `production` at launch (runbook), with the prod Privy app's card onramps enabled.

## Suggested commit message
feat(funding): card onramp sandbox on dev, faucet kept next to it (TASK-036b)
