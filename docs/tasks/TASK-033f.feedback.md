# TASK-033f feedback — manual fallback triggers (ADR-050)
Status: DONE — Live on dev (PR #93 merged by David, Deploy run 37229731748: guard, web Build → Deploy → Migrate green; indexer and worker unchanged)

Spec: `docs/tasks/TASK-033-voting-lifecycle.md` §033f. Decision: David, 2026-10-04 21:07 — **"ročno"** (manual; no relayer key on the server for the testnet MVP), recorded as **ADR-050** (amends ADR-045 §4).

## What I implemented
- **Rules** (`apps/web/src/lib/admin/guardian.ts`):
  - `FALLBACK_IDLE_SECONDS = 7 days` (ADR-045 default, a web-app constant — not a contract value).
  - `dueFallbacks(lc, now)`: `finalize` when `LIVE` and `now ≥ deadline + 7 days`; `closeVote` when `VOTING` and `now ≥ voteEnd + 7 days`; `sweepUnclaimed` when `FAILED`/`REJECTED`, not swept and `now ≥ settlementStart + snap_refund_sweep_delay` (the campaign's own snapshot; unknown snapshot → never). Checked against `Campaign.sol`: all three functions are `external` without a role check, so any wallet may call them; `sweepUnclaimed` reverts with `NotFailedOrRejected`, `AlreadySwept`, `SweepDelayNotReached`, `PoolNotConfigured`.
  - `openChainActions(lc, now)` now includes the three fallbacks; `CHAIN_ACTIONS` extended, so intent/sent and the campaign log handle them like 033d.
  - `loadGuardianQueue(db, now)` adds the due fallbacks with the tasks `finalize_overdue`, `close_vote_overdue`, `sweep_due`, sorted by the moment each task became due (oldest first). The admin home tile counts them automatically.
  - Notes: required only for `resolve` / `freeze`; optional for the payout plan and the fallbacks.
- **API** `POST /api/admin/campaigns/:id/chain-actions`: accepts `{ action: "finalize" | "closeVote" | "sweepUnclaimed", note? }`; refused with 409 `wrong_state` unless due.
- **Client** `lifecycle-client.ts`: `{ kind: "sweepUnclaimed" }`; `SweepDelayNotReached` → `not_due`, `PoolNotConfigured` → new `pool_not_configured` message.
- **Admin campaign page** (`GuardianPanel.tsx`): box **"CHERR.IO steps in"** with the one due call — **Finish the campaign** / **Count the votes** / **Move to the Emergency Pool** (checkbox confirmation: donors can no longer claim). No role needed: the first connected admin wallet signs; the panel says any wallet pays its own POL. `ChainActions.tsx` log texts for the three actions.
- **Admin → Chain actions** intro and task names updated.
- **Polish (David's feedback 2026-10-04)**: Account → Email settings shows **"Change address"** / "New email address" once a contact address is confirmed; entering the confirmed address again → 409 `same_as_contact` ("This is already your confirmed address — nothing to confirm."), no new link queued.
- **Worker digest email** to admins (optional in the HANDOFF plan): **not done** — the admin home tile and the queue are enough for now; easy to add later as an `ADMIN_FALLBACK_DUE` kind.

## Files changed
- `apps/web/src/lib/admin/guardian.ts` — fallback rules, queue, action list.
- `apps/web/src/app/api/admin/campaigns/[id]/chain-actions/route.ts` — schema for the fallbacks.
- `apps/web/src/lib/campaigns/lifecycle-client.ts` — `sweepUnclaimed`, error mapping.
- `apps/web/src/app/[locale]/admin/campaigns/[id]/GuardianPanel.tsx`, `ChainActions.tsx` — UI.
- `apps/web/src/lib/notifications/preferences.ts`, `apps/web/src/app/api/me/notifications/email/route.ts`, `apps/web/src/app/[locale]/account/notifications/NotificationSettingsForm.tsx` — `same_as_contact`, "Change address".
- `apps/web/messages/en.json` — texts.
- Tests: `src/__tests__/guardian.test.ts`, `lifecycle-client.test.ts`, `notification-preferences.test.ts`, `e2e/guardian.spec.ts`, `e2e/notifications.spec.ts`.
- Docs: `docs/03-DECISIONS.md` (ADR-050), `docs/tasks/TASK-033-voting-lifecycle.md`, `docs/tasks/README.md`, `docs/whitepaper/CORRECTIONS.md` (#6 → "CHERR.IO's team does it"), owner guide §8 **v1.3** + PDF + change log, `docs/technical/04-web-app-and-auth.md`, `docs/technical/09-status-and-roadmap.md`, `docs/guides/fundraisers.md`, `docs/guides/donors.md`.

## Deviations from the task (and why)
- The spec's worker job with an operator key became a manual admin action (ADR-050, David's decision).
- `sweepUnclaimed` is due exactly at `settlementStart + snap_refund_sweep_delay` — no extra 7 days, because nobody else is expected to call it (it is itself the end of the refund window).

## New dependencies
- none

## How to verify
1. `pnpm --filter web test` → 422 passed.
2. `cd apps/web && pnpm build && CI=1 pnpm exec playwright test e2e/guardian.spec.ts e2e/notifications.spec.ts --retries=0` → 8 passed.
3. On dev after deploy: https://dev.cherr.io/en/admin/guardian — a campaign still LIVE 7 days after its deadline shows "Finish — nobody did for 7 days". (On Amoy-dev none may be due yet: "Lorem ipsum" ends 2026-11-01.)

## Test results (real outputs, this session, 2026-10-04)
```
$ pnpm exec vitest run src/__tests__/guardian.test.ts
 ✓ src/__tests__/guardian.test.ts (13 tests) 500ms
      Tests  13 passed (13)

$ pnpm --filter web test
 Test Files  46 passed (46)
      Tests  422 passed (422)

$ CI=1 pnpm exec playwright test e2e/guardian.spec.ts --retries=0
  6 passed (25.0s)
$ CI=1 pnpm exec playwright test e2e/notifications.spec.ts --retries=0
  2 passed (15.0s)

$ pnpm --filter='!@cherrio/contracts' typecheck   → apps/web typecheck: Done (all packages)
$ pnpm --filter='!@cherrio/contracts' lint        → no errors
$ pnpm check:design                               → Design check passed — no violations found.
$ npm run owner-guide → PDF docs/guides/owner/dist/CHERR.IO-Contracts-Owner-Guide-v1.3.pdf (17 pages)
```

Deliberate breaks (each restored afterwards, suite green again: `Tests 13 passed (13)` / `6 passed`):
```
# finalize rule `>=` → `>` (one second late)
 FAIL  dueFallbacks (TASK-033f, ADR-050) > finalize: LIVE, exactly 7 days after the deadline — not one second earlier
AssertionError: expected false to be true // Object.is equality
      Tests  1 failed | 12 passed (13)

# queue without the "due" filter (`or q.due_at <= now` → `or true`)
 FAIL  … > the queue lists exactly the campaigns waiting for an admin, with their task
AssertionError: expected [ [ …(2) ], [ …(2) ], [ …(2) ], …(1) ] to deeply equal [ [ …(2) ], [ …(2) ], [ …(2) ] ]
 FAIL  … > the queue lists the due fallbacks only once they are due (TASK-033f)

# same_as_contact check disabled
 FAIL  notification settings (Postgres) > double opt-in for a wallet-only user: …
AssertionError: expected { status: 200, body: { …(6) } } to deeply equal { status: 409, …(1) }
      Tests  1 failed | 5 passed (6)
```
First E2E run of the new notifications step failed on the locator (`getByRole('alert')` matched the Next.js route announcer too); the message itself was shown. Fixed by filtering on the text; rerun: `2 passed`.

## docs/technical chapters updated
- 04 (admin queue, admin campaign page, lifecycle client, chain-actions API, email settings), 09 (TASK-033 row).

## Open questions / risks
- Before mainnet: server relayer key or a Safe module for these calls (ADR-050 §5).
- On prod the admin's wallet pays POL for the fallback calls (cheap on Polygon).

## Suggested commit message
feat(web): manual fallback for idle campaigns in Admin → Chain actions (TASK-033f, ADR-050)
