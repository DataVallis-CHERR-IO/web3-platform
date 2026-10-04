# TASK-036 — "Add money": card top-up of the CHERR.IO wallet (ADR-051)

Decision: David, 2026-10-04 — Privy funding flow with Stripe + Coinbase, Transak as fallback; minimum top-up 20 €; David applies for Stripe Onramp and Coinbase zero-fee USDC on 2026-10-05.
Supersedes TASK-012. Depends on TASK-011c (smart account).

## Goal
A donor with a CHERR.IO wallet (Privy embedded wallet + smart account) can put money on it with a card, then donate from it as today (one sponsored transaction). Donors with their own external wallet fund it themselves (unchanged).

## Parts
| Part | Branch | Scope | Needs David |
|---|---|---|---|
| 036a | `feat/TASK-036a-add-money` | `lib/funding/topup.ts` (minimum 20 €, suggested amount, mode per environment, `useAddFunds` options); `components/funding/AddMoney.tsx`; "Add money" on Account → wallets (smart account) and in the donate panel when the smart account has too little USDC; `FUNDING_ONRAMP` switch (default `off`); faucet mode on test networks; tests; docs | — |
| 036b | `feat/TASK-036b-onramp-live` | Enable providers in the Privy dashboard (Stripe, Coinbase); `FUNDING_ONRAMP=sandbox` on dev (Stripe test card 4242…); record the result; then `production` for prod at launch. Optional: balance shown next to "Add money", refresh after funding | Stripe/Coinbase approval, Privy dashboard |

## Rules
- Destination: the user's **smart account** address, chain `eip155:137`, native USDC (`0x3c49…3359`). On a test network with `FUNDING_ONRAMP=sandbox`, the sandbox flow still targets Polygon mainnet (onramps have no testnet delivery) — it only exercises the UI; nothing arrives.
- Minimum 20 € (`MIN_TOPUP_EUR`), whole euros, maximum 10,000 € (sanity cap; providers apply their own limits). Suggested amount when a donation fails for lack of USDC: the missing amount in EUR plus 5 % for provider fees, rounded up to whole euros, at least 20 €.
- Modes: `faucet` (test network, `FUNDING_ONRAMP` not `sandbox`) — Circle faucet link + the address to paste; `onramp` (`sandbox` or `production`) — amount field + "Add money with a card" → Privy modal; `none` (mainnet with `FUNDING_ONRAMP=off`) — no box.
- All texts via next-intl. No secrets: Privy/Stripe/Coinbase keys stay in the Privy dashboard.

## Tests
- Unit: minimum and rounding, suggested amount, mode table, `useAddFunds` options (address, chain, asset, EUR default, environment).
- E2E (local = faucet mode): Account shows "Add money" with the smart-account address and the faucet link; donate panel with a fake smart wallet and too little USDC shows the same box with the suggested amount.

## Docs
- technical 04 (account, donate panel), 01 (onramp row), 05 (`FUNDING_ONRAMP`), 09; donors guide; Product Spec §card flow; Architecture card flow; feedback `TASK-036a.feedback.md`.
