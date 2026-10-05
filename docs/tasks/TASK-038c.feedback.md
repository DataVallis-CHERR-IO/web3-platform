# TASK-038c feedback
Status: DONE (Built; Live on dev after merge + deploy)

## What I implemented
- `lib/campaigns/publish-flow.ts`: the browser publish flow extracted from `PublishPanel` — `withTimeout`, `postJson`, `pickOperatorWallet`, `publishFlow(campaignId, deps)` with injected server calls, wallet discovery, signing, receipt wait and sleep. Returns a result kind (`deployed`, `not_linked_yet`, `prepare_failed`, `no_operator_wallet`, `check_failed`, `record_failed`, `reverted`, `rejected_by_user`, `failed`).
- `PublishPanel` ("Publish on Polygon") now uses `publishFlow`; messages and behaviour unchanged (same steps, same error texts, "Check status" after linking).
- `admin/demo/PublishAll.tsx`: `publishBatch` (operator wallet found once per round and reused; a rejected signature or a missing operator wallet stops the round; other failures are listed, the next campaign follows) and the "Publish all N demo campaigns" panel (first 10 waiting demo campaigns, progress per campaign and step, summary, page refresh).
- Owner guide **v1.4** (§8 "Demo campaigns on the test network", table row), change log, PDF rebuilt (17 pages; v1.3 PDF removed).

## Deviations from the task (and why)
- none.

## New dependencies
- none

## How to verify (on dev after deploy)
1. https://dev.cherr.io/en/admin/demo with demo campaigns waiting → panel "N demo campaigns wait to be published on chain (at most 10 per round)…" and **"Publish all N demo campaigns"**.
2. Log in, connect MetaMask 0x4326…B5a7, click it → MetaMask asks once per campaign; the status line shows "Campaign 1 of N — <title>: Confirm in your wallet…", then "Waiting for the indexer…".
3. At the end: "N published." (or the not-linked / failed counts); the list shows "Published — open page".

## Test results (real outputs, 2026-10-05, sandbox)
- `vitest run src/__tests__/publish-flow.test.ts src/__tests__/campaign-publish-client.test.ts` → `Tests  10 passed (10)` (5 new).
- Deliberate break (batch does not keep the operator: `operator: null` per campaign): `× publishBatch > finds the operator wallet once and publishes every campaign → expected [ 'pick', 'pick', 'pick' ] to have a length of 1 but got 3`; restored → `Tests  5 passed (5)`.
- `pnpm --filter web typecheck` / `lint` → clean; `pnpm build` → exit 0; Playwright `campaign-review` (publish panel) + `admin-demo` → `8 passed (26.1s)`.
- `pnpm --filter web test` → `Test Files  51 passed (51)`, `Tests  452 passed (452)`.
- Real signing on Amoy: NOT RUN — needs David's Operator wallet; first real run is David's check on dev.
- Owner guide: `npm run owner-guide` → `PDF … CHERR.IO-Contracts-Owner-Guide-v1.4.pdf (17 pages)`.

## Docs updated
technical 04, 09; owner guide v1.4 + README change log + PDF.

## Suggested commit message
feat(web): publish all demo campaigns with one operator round (TASK-038c)
