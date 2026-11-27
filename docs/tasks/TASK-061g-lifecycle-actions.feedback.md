# TASK-061g feedback
Status: PARTIAL (module + tests done; live run NOT RUN)

## What I implemented
- `apps/agents/src/lifecycle.ts`: `crewCampaignsForLifecycle()`, pure `nextLifecycleAction()`, Playwright `lifecycleStep()`, cap `MAX_LIFECYCLE_ACTIONS_PER_RUN = 3`.
- Crew campaign = `demo === true` and organisation name ending " (testnet)" (own helper `isCrewLifecycleCampaign`; none on origin/dev). States kept: ending, succeeded, voting, failed, rejected; all pages of `/api/v1/campaigns?sort=ending`; URLs must be on the testnet origin.
- Decision: own position first (vote-approve only when donated, not yet voted this round, state VOTING; settle-to-pool when the API's action is `pool`, else refund), then finalize, close-vote, release if due, else none with a reason. Agents never reject.
- Driver: signs in once per session, reads `/api/lifecycle/:contract` through the logged-in browser context (positions are only returned for a session), opens the page, scrolls to `#lifecycle`, clicks the button by accessible name, waits for "Sent…" then "Confirmed…" (180 s each), records step `lifecycle` (`finalize "Title": confirmed`), then polls the API (15 s, up to 3 min) and records `lifecycle indexed`.
- Signer policy (`policy.ts` CAMPAIGN_CALLS) already allows vote, closeVote, finalize, release, claimRefund, settleToPool for every crew wallet; read, not changed.

## Files changed
- apps/agents/src/lifecycle.ts (new), apps/agents/test/lifecycle.test.ts (new), this file.

## Deviations from the task (and why)
- none. Not edited: run.ts, dispatcher.ts, models.ts, docs/technical, apps/web.

## New dependencies
- none

## How to verify
1. `pnpm --filter agents test` / `lint` / `typecheck`

## Test results (real, this session)
- test: `Test Files 10 passed (10)`, `Tests 165 passed (165)`, `test/lifecycle.test.ts (11 tests)`.
- lint and typecheck: no output beyond the command line (clean).
- Guards that can fail (code broken once, test failed, restored):
  - vote without the "not yet voted / vote action" check -> FAIL "never votes twice in a round, and never without a donation"
  - refund/pool branch swapped -> FAIL "refunds on REFUND, sends to the pool on POOL, only for its own position"
  - crew filter without `demo === true` -> FAIL (2 tests: filtering over pages, person's campaign never crew)
  - address match removed -> FAIL (2 tests: never votes twice…, refunds…only for its own position)

## NOT RUN
- Live: `lifecycleStep` against testnet.cherr.io — NOT RUN, needs the agents environment (no access from this sandbox). Button names come from messages/en.json; unverified against a real page.

## Open questions / risks
- Cap counter is per process (module map); runner should call `resetLifecycleCounts()` only in tests.
- `lifecycleStep` signs in on first use per session; do not call `signIn` again for the same session.

## Suggested commit message
feat(agents): agents drive the campaign life-cycle panel (TASK-061g)
