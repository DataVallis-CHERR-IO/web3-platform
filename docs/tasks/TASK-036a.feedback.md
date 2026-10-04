# TASK-036a feedback — "Add money" UI, faucet mode, onramp switch (ADR-051)
Status: DONE — Live on dev (PR #95, Deploy run 37233679418: guard, web Build → Deploy → Migrate green)

Spec: `docs/tasks/TASK-036-add-money.md`. Decisions: David, 2026-10-04 22:27 — Privy funding flow (Stripe + Coinbase, Transak fallback), minimum top-up 20 €, he applies for Stripe Onramp and Coinbase zero-fee USDC on 2026-10-05. Recorded as **ADR-051** (amends ADR-004; TASK-012 superseded).

## What I implemented
- `apps/web/src/lib/funding/topup.ts` (pure): `MIN_TOPUP_EUR = 20`, `MAX_TOPUP_EUR = 10,000`; `checkTopUp` (whole euros); `suggestTopUpEur(missingUsdc, usdPerEur18)` = missing amount in EUR + 5 % for the provider fee, ceiling to whole euros, at least 20 €; `parseFundingOnramp` / `fundingMode` / `fundingModeFromEnv` (`FUNDING_ONRAMP`: `off` default, `sandbox`, `production`; test network → faucet unless `sandbox`; mainnet + `off` → none); `addFundsOptions` for Privy `useAddFunds` (destination = smart account, `eip155:137`, native USDC; EUR default; environment).
- `apps/web/src/components/funding/AddMoney.tsx`: faucet mode (text, the full checksummed address with a copy button, link to faucet.circle.com) or onramp mode (amount field, "Add money with a card" → `useAddFunds().addFunds(...)`, statuses; without a Privy app it says it is unavailable instead of calling Privy hooks).
- Account → linked wallets: the box under the wallets when the user has a `SMART_ACCOUNT` address.
- Donate panel: when a CHERR.IO wallet (smart account) has too little USDC, the box appears under the error with the suggested amount (replaces the old faucet link for smart accounts; external wallets on a test network keep their faucet link).
- `FUNDING_ONRAMP` is read on the server only (campaign page, account page). It is **not set** on any environment yet → dev/uat show the faucet box, prod would show nothing.
- Docs: ADR-051, TASK-036 spec, tasks README (TASK-012 superseded), manifest stack line, Product Spec card flow, Architecture card flow, technical 01/04/05/09, donors guide.

## Files changed
- `apps/web/src/lib/funding/topup.ts`, `apps/web/src/components/funding/AddMoney.tsx` — new.
- `apps/web/src/components/campaigns/DonatePanel.tsx`, `apps/web/src/app/[locale]/campaigns/[slug]/page.tsx` — box in the donate panel, `funding` prop.
- `apps/web/src/app/[locale]/account/page.tsx`, `AccountClient.tsx` — box on the account page.
- `apps/web/messages/en.json` — `funding.*`.
- Tests: `apps/web/src/__tests__/funding-topup.test.ts` (new), `apps/web/e2e/donate.spec.ts` (new test + `balance` in the fake wallet).
- Docs listed above.

## Deviations from the task (and why)
- No USDC balance next to "Add money" yet (moved to 036b): it needs a read through `/api/rpc`, and the box is useful without it.
- No `FUNDING_ONRAMP` line in `config/deploy*.yml`: unset means `off`; it is added in 036b when David has the provider approvals.

## New dependencies
- none (`useAddFunds` is in the installed `@privy-io/react-auth` 3.46.0, marked experimental by Privy).

## How to verify
1. `pnpm --filter web test` → 427 passed.
2. `cd apps/web && pnpm build && CI=1 pnpm exec playwright test e2e/donate.spec.ts --retries=0` → 8 passed.
3. On dev after deploy, logged in with email/Google: https://dev.cherr.io/en/account → under the wallets a box **"Add money"** with "This is the test network (Polygon Amoy)…", the full donation-account address and **"Get free test USDC"**.

## Test results (real outputs, this session, 2026-10-04)
```
$ pnpm exec vitest run src/__tests__/funding-topup.test.ts
 ✓ src/__tests__/funding-topup.test.ts (5 tests) 6ms
      Tests  5 passed (5)

$ pnpm test   (apps/web)
 Test Files  47 passed (47)
      Tests  427 passed (427)

$ CI=1 pnpm exec playwright test e2e/donate.spec.ts --retries=0
  8 passed (28.3s)

$ pnpm exec tsc --noEmit -p .   → no errors
$ pnpm lint                      → no errors
$ pnpm check:design              → Design check passed — no violations found.
  (first run flagged two comments containing "rounded"; reworded)
```
Deliberate breaks (restored afterwards; 5/5 green again):
```
# FEE_BUFFER_PERCENT 5n → 0n
 FAIL  … > suggestTopUpEur > the missing amount in EUR + 5 %, rounded up, at least 20 €
AssertionError: expected 100 to be 105 // Object.is equality

# test network → "none" instead of "faucet"
 FAIL  … > fundingMode > faucet on a test network, the onramp only when switched on, sandbox wins everywhere
AssertionError: expected { kind: 'none' } to deeply equal { kind: 'faucet' }
```
The onramp mode (`useAddFunds`) is **NOT RUN** end to end — it needs Privy with Stripe/Coinbase enabled (036b). Its options are unit-tested.

## docs/technical chapters updated
- 01 (feature row, cost row, integrations), 04 (account, campaign page), 05 (`FUNDING_ONRAMP`), 09 (TASK-012 superseded, TASK-036 row).

## Open questions / risks
- `useAddFunds` is experimental in Privy's SDK; a Privy upgrade may change it (the options builder is one place to adapt).
- Whether Privy's flow accepts a smart-account address as the destination with every provider — verify in the sandbox (036b).
- Providers' own minimums may exceed 20 € for some methods; their UI then says so.

## Suggested commit message
feat(web): "Add money" box — faucet on test networks, Privy card top-up behind FUNDING_ONRAMP (TASK-036a, ADR-051)
