# TASK-010b feedback — ECB rate, USDC target, campaign review
Status: DONE (in code) — everything in scope is implemented and green locally; GitHub Actions results are added to the PR. Labels stay **Built** until the first approval on dev proves that the server reaches the ECB.

Working mode: autonomous CTO + implementer (HANDOFF 2026-10-02): plan, code, tests, commit on `feat/TASK-010b-campaign-review`, PR to `dev`, merge only when CI is green.

## Steps for David
1. After the deploy: approve one submitted campaign on dev (`/en/admin` → "Campaigns waiting for review"). The snapshot must show an ECB rate dated the last ECB working day. If it says "The ECB exchange rate could not be loaded", the server cannot reach `www.ecb.europa.eu` — tell me.
2. Nothing else: no new secrets, no new configuration, no migration.

## What I implemented
- **EUR→USDC (ADR-036):** `eurCentsToUsdc` in `@cherrio/shared` now rounds **down**: `(cents × rate) / 10_000` with the rate as integer × 1e8 — the same as `floor(target_eur_cents × rate × 10^4)`. Before, it rounded **up** (from TASK-005, never used); the ADR wins. New constant `MIN_CAMPAIGN_TARGET_USDC = 100 USDC`.
- **ECB client** `apps/web/src/lib/campaigns/ecb.ts`: fetches `https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml` (5 s timeout, no cache) and reads the USD rate and the rate date from the published format. It refuses an answer without a USD rate or date, with more than 8 decimals, outside 0.5–3.0, older than 7 days or in the future. `ECB_RATES_URL` overrides the URL **only with `APP_ENV=local`**.
- **Review logic** `lib/campaigns/review.ts`:
  - Approve does cheap checks first, so an unknown or already decided campaign never triggers an ECB request. Then it fetches the rate **outside** the transaction, so no lock is held during a network call.
  - Then one transaction locks the campaign (`FOR UPDATE`) and the organisation (`FOR SHARE`) and runs these checks:
    - the campaign is still `PENDING_REVIEW`;
    - the reviewer is not a member of the organisation in any role and did not start the campaign;
    - the organisation is still `APPROVED` and has a payout address;
    - the target is at least 100 USDC.
  - If all pass, it sets the rate (8 decimals), `rate_source = ECB`, `rate_at` (the ECB date), `target_usdc`, the beneficiary (the organisation's payout address), a random 32-byte `offchain_id`, the reviewer and the time, and clears `review_note`.
  - Audit `campaign.approve` with ids, rate, rate date and target only.
  - Reject → `REJECTED` with the note; audit `campaign.reject` (the note is not copied).
- **API:** `POST /api/admin/campaigns/:id/approve` (empty body, `.strict()`) and `/reject` (`{ note }` 10–1,000).
  - 404 for everyone except a `PLATFORM_ADMIN` re-read from the DB; origin check.
  - Refusals: 409 with a code; a missing rate is **503 `rate_unavailable`**.
- **Pages:**
  - `/en/admin/campaigns`: queue, oldest submission first.
  - `/en/admin/campaigns/[id]`: all fields, the payout address (checksummed), cover, escaped story, the snapshot after approval, and the approve dialog / reject note. A draft that was never submitted is a 404.
  - A link on `/en/admin`.
  - All texts are in `admin.campaigns.*`.
  - The organisation's own page already showed the reviewer's note for `REJECTED` (010a); E2E now proves it.

## Files changed
- `packages/shared/src/money.ts`, `test/money.test.ts` — floor rounding, minimum constant, new examples
- `apps/web/src/lib/campaigns/ecb.ts`, `review.ts`, `review-route.ts` (new)
- `apps/web/src/app/api/admin/campaigns/[id]/approve/route.ts`, `reject/route.ts` (new)
- `apps/web/src/app/[locale]/admin/campaigns/page.tsx`, `[id]/page.tsx`, `[id]/ReviewActions.tsx` (new); `admin/page.tsx` (link)
- `apps/web/messages/en.json` — `admin.campaignsLink`, `admin.campaigns.*`
- `apps/web/src/__tests__/campaign-ecb.test.ts`, `campaign-review.test.ts`, `fixtures/ecb-eurofxref-daily.xml` (new)
- `apps/web/e2e/campaign-review.spec.ts` (new), `e2e/helpers/session.ts` (`createSubmittedCampaign`; cleanup also deletes the campaigns' audit rows)
- `apps/web/playwright.config.ts`, `playwright.env.ts` — `ECB_RATES_URL` of the E2E server → fixture server on port 4010
- `docs/technical/01, 03, 04, 06, 07, 08, 09`, `docs/tasks/README.md`

### `docs/technical/` chapters updated
- **01** §3.1 — the Phase 1 off-chain lifecycle (draft, review, publish), plus the role rows.
- **03** — campaign columns at approval and rejection.
- **04** — two pages, two routes, the review rules.
- **06** — row "Campaign review".
- **07** — counts and E2E coverage.
- **08** — new §5.1a "Review a campaign".
- **09** — TASK-010 row.
- **02 and 05** are unchanged: 02 belongs to 010c (who calls `createCampaign`); there is no new infrastructure for 05.

## Deviations from the task (and why)
- **`eurCentsToUsdc` changed from ceiling to floor.** It is an existing exported helper, but nothing called it; ADR-036 says floor. The old round-trip test (which assumed the ceiling) was replaced, so `@cherrio/shared` has 55 tests instead of 56.
- **The ECB fixture is written in the ECB's published format with illustrative values.** The sandbox cannot reach `ecb.europa.eu` (proxy 403), so it is not a byte copy of a downloaded file. The parser uses only `time='…'` and `currency='USD' rate='…'` (single or double quotes). The first approval on dev is the live proof.
- **Approval has no typed confirmation.** The address was already confirmed character by character at KYB, and a campaign cannot change it, so the dialog only shows the address and asks to confirm.
- **The starter of the campaign may not review it either** — in addition to the membership rule; normally implied, since the starter is an `ORG_ADMIN`.
- **Diff size:** about 1,240 changed lines without docs; about 470 of them are tests and 26 are the fixture. Not split: the logic, API and pages are reviewed together, and no half is useful alone.

## New dependencies
- none

## How to verify
1. `export DATABASE_URL=postgres://cherrio:cherrio@127.0.0.1:5432/cherrio_dev DATABASE_URL_DIRECT=$DATABASE_URL`
2. `pnpm --filter @cherrio/shared test` → 55 passed
3. `pnpm --filter web test` → 16 files, 117 passed
4. `pnpm --filter @cherrio/db test:integration` → 16 passed
5. `pnpm --filter 'web...' --filter '!@cherrio/contracts' build`, then `cd apps/web && CI=1 pnpm test:e2e` → 106 passed

## Test results (all from this session)
Environment: cloud sandbox, not David's Mac. Docker Hub and Google Fonts cannot be reached from it, so these local substitutes were used. Nothing in the repo depends on them.
- Postgres 16 + pgvector runs as a local process.
- `moto` (S3 server) stands in for s3mock on port 9090.
- The build uses `NEXT_FONT_GOOGLE_MOCKED_RESPONSES`.
- Playwright 1.63 runs on the preinstalled headless shell 1194.

Results:
- `@cherrio/shared`: `Tests 55 passed (55)`.
- `web`: `Test Files 16 passed (16)`, `Tests 117 passed (117)` (104 before + 5 `campaign-ecb` + 8 `campaign-review`).
  - First run of `campaign-ecb`: `1 failed | 4 passed`. My test used `117.34` for the implausible-rate case, but the format check refuses that value earlier with "unexpected USD rate". Changed the test value to `3.5`.
- `@cherrio/db` integration: `Tests 16 passed (16)`.
- Lint (`pnpm --filter='!@cherrio/contracts' lint`): no errors.
- Typecheck: no errors. The first run had 5 type errors in the new tests (casts to `ProcessEnv`, a missing return); fixed.
- `check:design`: passed.
- E2E new spec: `4 passed` (2 tests × 2 viewports). Whole suite: `106 passed (2.8m)`.
- **Deliberate break 1** (floor → ceiling in `eurCentsToUsdc`): `Tests 1 failed | 27 passed (28)`, with `AssertionError: expected 11235n to be 11234n` in "rounds DOWN with an 8-decimal rate". Restored → 55 passed.
- **Deliberate break 2** (self-review check removed in `lockForReview`): `Tests 1 failed | 7 passed (8)`, with `expected { status: 200, … } to deeply equal { status: 409, … }` in "a reviewer who belongs to the organisation is refused". Restored → 8 passed.

## NOT RUN
- docker build — not run locally (rule since TASK-028); CI "Image build" builds both images.
- Live ECB request — not reachable from the sandbox; proven by the first approval on dev.
- Contract and indexer tests — untouched.

## Open questions / risks
- **ECB rate time:** the ECB publishes around 16:00 CET. An approval in the morning uses the previous working day's rate. This is accepted by ADR-036 ("latest").
- **The ECB is an external dependency of approval.** If it is down, admins retry later. There is no fallback, by design (no manual rate).
- **Approval cannot be undone in the UI.** A wrong approval before publishing must be corrected in the DB by David (documented in 08 §5.1a).

## Suggested commit message
feat(web): campaign review with ECB EUR→USDC snapshot, admin queue and detail pages (TASK-010b)
