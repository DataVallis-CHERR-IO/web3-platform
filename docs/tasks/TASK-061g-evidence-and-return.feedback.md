# TASK-061g feedback
Status: PARTIAL (modules and unit tests done; the live flow is NOT RUN — it needs the agents environment)

## What I implemented
- `apps/agents/src/evidence.ts`: `submitEvidence(ctx)` for a crew fundraiser. Lists its campaigns (`/en/account/campaigns`), reads `GET /api/campaigns/:id/evidence` for each, takes the first one whose panel is open (PAYING, MILESTONES, payment 1 or 2 released; at most one per run), saves a fixed note, adds one drawn PDF receipt ("TEST DOCUMENT"), clicks "Seal and submit to the blockchain", waits for "Confirmed. The vote starts as soon as CHERR.IO sees it", then polls `GET /api/lifecycle/:address` until the state is `VOTING`. Records step `evidence`. A sealed-but-unsubmitted bundle from an earlier run is resumed with "Submit to the blockchain". Pure helpers: `evidenceNote`, `openEvidence`, `pickEvidenceTarget`, `campaignIds`, `campaignAddressIn`, `lifecycleState`.
- `apps/agents/src/return-funds.ts`: `returnFunds(chain, crew, member, record, o)` (node, no browser). Reads the member's USDC `balanceOf`; for a `fundraiser` with at least `RETURN_MIN_USDC` (5 USDC, `5_000_000n`) sends all of it to the treasury through `checkTransaction` + `senderFor`; records `return funds` with amount and tx hash. Never for the treasury or other personas.
- policy.ts: `submitEvidence` is already in `CAMPAIGN_CALLS` (any crew persona) and a USDC transfer to a crew address is allowed. Confirmed, not widened.

## Files changed
- apps/agents/src/evidence.ts, apps/agents/src/return-funds.ts — new
- apps/agents/test/evidence.test.ts, apps/agents/test/return-funds.test.ts — new
- docs/tasks/TASK-061g-evidence-and-return.feedback.md — this file
- Not touched: run.ts, dispatcher.ts, models.ts, docs/technical/*, apps/web.

## Deviations from the task (and why)
- The campaign contract address is not in any API the agent can read for a not-live campaign, so `campaignAddressIn` takes it from the page data (`"campaign":"0x…"` that the page passes to EvidenceManager). If it is not found, the VOTING check falls back to the evidence API (`onChain`) and the step detail says so. Unverified live.
- `ReturnOptions.send`, `.treasuryAddress`, `.pollingInterval` are test seams (a non-crew treasury address makes the policy refuse).
- docs/technical/ not updated: the modules are not wired into the runner yet (run.ts is out of scope), so no behaviour changed.

## New dependencies
- none

## How to verify
1. `pnpm --filter agents test`, `lint`, `typecheck`
2. Live (agents environment, after the runner calls the two functions): a fundraiser with a PAYING milestone campaign records `evidence` ✓ and `return funds` ✓.

## Test results
- `pnpm --filter agents test`: Test Files 11 passed (11), Tests 168 passed (168) (14 new).
- `pnpm --filter agents lint` and `typecheck`: no output, exit 0.
- Deliberate breaks (each restored afterwards; final run green):
  - `balance >= min` → `>`: FAIL returnPlan "is the whole balance at or above the threshold" (expected 0n to be 5000000n)
  - persona check removed: same test fails (expected 99000000n to be 0n)
  - policy verdict ignored: FAIL "a policy refusal is a failed step and nothing is sent" (expected 'returned' to be 'failed')
  - `if (mine?.onChain) return null` removed: FAIL "nothing when the panel is closed, the round is odd or it is already on chain"
  - `payment: round + 2` → `+ 1`: 2 failures (round 0 is payment 2; first open campaign only)
- NOT RUN — live: testnet.cherr.io needs the agents environment. The selectors ("Note to donors", "Save the note", "Add a file", the file row text, the confirmation text) come from EvidenceManager.tsx / en.json and are unverified in a browser.

## Open questions / risks
- The runner must call `submitEvidence(ctx)` for fundraisers and `returnFunds(chain, crew, member, record, { rpcUrl, beforeSend })` after the browser tasks (payouts are released by donors/anyone, so run it late). `beforeSend` should spend the "transactions" budget.
- `getByLabel("Add a file")` on the shared `FileField` may need a selector tweak on first live run.

## Suggested commit message
feat(agents): fundraisers submit milestone evidence and return payouts to the treasury
