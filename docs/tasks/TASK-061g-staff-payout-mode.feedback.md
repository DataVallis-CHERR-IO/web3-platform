# TASK-061g feedback
Status: PARTIAL (pure logic tested; the browser flow is NOT RUN against the live app)

## What I implemented
- `apps/agents/src/staff-payout.ts`: `setPayoutPlans(ctx, opts)`. Admin → Chain actions lists the campaigns whose task is "Set the payout plan". Each one is opened. The agent reads the server-set "Crew agent" row and the payout address, and checks them (crew wallet, never red team, never a person's). It then reads the "Payout plan" row (skips it unless "Not set yet"), reads "Suggested: …" (default "One payment"), picks the radio, types the note "Testnet staff agent: suggested plan (ADR-049)" and presses "Set the payout plan" once the page enables it. It waits for the panel's message ("Sent. The page updates…"), reloads until the "Payout plan" row shows the plan, and records step "payout plan".
- At most `MAX_PAYOUT_PLANS_PER_RUN = 2` plans per run, `MAX_PAYOUT_OPENED_PER_RUN = 20` queue entries opened.
- Pure helpers, exported and unit-tested: `parseSuggestion`, `choosePlan`, `crewVerdict`, `payoutTargets`, `classifyOutcome`.
- Signer policy (`apps/agents/src/policy.ts`) checked, not changed: `CAMPAIGN_CALLS_STAFF = {"setPayoutMode"}` is allowed for persona "staff" only, on any CHERR.IO campaign contract (`ctx.isCampaign`). It does not look at the campaign's beneficiary or the mode. The crew check therefore lives in this module (page-side). The contract itself refuses SINGLE for individuals.

## Files changed
- apps/agents/src/staff-payout.ts — new module
- apps/agents/test/staff-payout.test.ts — new unit tests
- docs/tasks/TASK-061g-staff-payout-mode.feedback.md — this file

## Deviations from the task (and why)
- none. run.ts, dispatcher.ts, models.ts, docs/technical and apps/web are untouched; the runner still has to call `setPayoutPlans`.

## New dependencies
- none

## How to verify
1. `pnpm --filter agents test`, `pnpm --filter agents lint`, `pnpm --filter agents typecheck`
2. Live: NOT RUN — live: needs the agents environment (testnet.cherr.io is unreachable from this sandbox).

## Test results
- `pnpm --filter agents test`: Test Files 10 passed (10), Tests 164 passed (164) (10 of them new)
- lint: no output after `eslint .`; typecheck: no output after `tsc --noEmit`
- Deliberate breaks (each restored afterwards, then green again):
  - red-team check removed → FAIL "refuses a red-team wallet even when it is listed as crew" (expected { ok: true } to deeply equal { ok: false … })
  - person check removed → FAIL "refuses a person's campaign" (expected true to be false)
  - crew-wallet check inverted → FAIL "accepts a crew campaign" and "refuses a payout address that is not a crew wallet"
  - cap 2→5 → FAIL "caps the opened rows and sets at most two plans per run" (expected 5 to be 2)
  - default plan "single"→"milestones" → FAIL "gives null for anything else; the default is One payment" (expected 'milestones' to be 'single')

## Open questions / risks
- The selectors come from reading GuardianPanel.tsx, ChainActions.tsx, guardian/page.tsx and en.json, not from a live run: `section[aria-labelledby="guardian-payout"]`, region "Chain actions" (the queue table), the cell text "Set the payout plan" in column 4, message boxes `div.ch-panel[role=status|alert]`. A first live run may need adjustment (as publish did).
- Confirmation text is "Sent. The page updates when the indexer has seen the transaction (about a minute)."; "Sent, but the result is not known yet…" counts as sent; "The transaction failed on the blockchain…" as a failure.
- The guardian queue lists every campaign with an open task, crew rows and people's alike, with no crew marker. The agent therefore opens each row and checks the page. A person's row is skipped (counted as "left for a person").
- Indexer lag: if the plan row still says "Not set yet" after the wait, the step is recorded as failed. The next run would see "Not set yet" and send again, which the contract refuses ("once"), costing gas. Worth a runner-side guard, or a longer `indexWaitMs`.
- An individual's campaign is never touched (not crew); if one were, the "One payment" radio is disabled and the step fails.

## Suggested commit message
feat(agents): staff agent sets the payout plan of crew campaigns (TASK-061g)
