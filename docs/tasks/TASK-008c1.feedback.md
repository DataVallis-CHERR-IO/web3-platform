# TASK-008c-1 feedback — KYB review: logic and API
Status: DONE — proven locally. GitHub Actions is NOT RUN until pushed. The diff is 838 changed lines without docs (see "Size").

First of three PRs of PR C. No admin page yet: the two routes exist, nothing in the UI calls them (008c-2).

## What I implemented
- **Migration `0003_concerned_bruce_banner.sql`** (addition A): `ALTER TABLE "app"."kyb_submissions" ADD COLUMN "reviewed_at" timestamp with time zone;` — nullable, additive, backward compatible. Set on approve and reject.
- **`lib/organizations/review.ts`** — each action is one transaction; submission and organisation are locked `FOR UPDATE`.
  - Common checks: submission exists (else 404), is `PENDING` (`not_pending`), and the reviewer is neither the submitter **nor an `ORG_ADMIN` of the organisation** (`self_review`, addition C).
  - **Approve:**
    - the stored `application` is validated again with `organizationApplicationDataSchema` (`application_invalid` if not usable);
    - the last six characters of the payout address must equal what the reviewer typed, case-insensitive (`payout_address_mismatch`, addition B);
    - submission `APPROVED`, `reviewer_id`, `reviewed_at`;
    - organisation: name, legal name, country, website, description, causes, payout address from the application; `kyb_status = APPROVED`;
    - claim: also `source = REGISTERED`, `claimed_by_user_id = submitted_by`, and other `ORG_ADMIN`s whose own submissions for this organisation were all rejected are removed (safety net);
    - audit `kyb.approve`.
  - **Reject** (note 10–1,000 characters, trimmed):
    - submission `REJECTED`, `reviewer_id`, `review_note`, `reviewed_at`;
    - new organisation → `REJECTED`; **claim → organisation back to `NONE`, row untouched, claimant's membership removed** (decision 1); an organisation with an earlier approved submission stays `APPROVED`;
    - audit `kyb.reject`; the note is not in the log.
  - Every removed membership: audit `organization.member_removed` (organisation id; data = removed user's id and the submission id).
- **Routes** `POST /api/admin/kyb/:submissionId/approve` and `…/reject`: `PLATFORM_ADMIN` re-read from the DB, 404 with an empty body for everyone else; then origin check; zod body; refusals as 409 with a code. Texts: `admin.kyb.errors.*`.
- **008b consequences of decision 1:**
  - `apply.ts`: an imported, unclaimed organisation in `NONE` can be claimed with `organizationId` too ("Submit again" = a new claim); register and number must then equal the organisation's.
  - New `lib/organizations/own-applications.ts` (`listOwnApplications`): the status page and the "Submit again" prefill now share one query. It reads the user's own submissions, so a rejected claim and its note stay visible after the membership is gone; `canResubmit` covers both cases (rejected organisation the user administers, or imported organisation back in `NONE`).
- **`@cherrio/shared`:** `organizationApplicationDataSchema` (the part stored in `application`).

## For 008c-2 and 008c-3
- 008c-2: the approve dialog must send `{ payoutAddressTail }` (6 characters), reject `{ note }`. The detail page should show the address checksummed (viem `getAddress`), as the stored value is lowercase.
- 008c-3: the sweep rule uses `reviewed_at`. `eraseUser` closing a pending submission must follow the same outcome as `rejectSubmission` (claim → `NONE`, new → `REJECTED`); the logic lives in `apps/web`, while `eraseUser` is in `packages/db`, so it will be written there again in SQL terms — I will keep the two next to a shared test.

## Files changed
- `packages/db/src/schema/organizations.ts`; `packages/db/drizzle/0003_concerned_bruce_banner.sql`, `meta/0003_snapshot.json`, `meta/_journal.json` (generated)
- `packages/shared/src/organizations.ts` — data schema
- `apps/web/src/lib/organizations/review.ts`, `review-route.ts`, `own-applications.ts` (new); `apply.ts` (claim condition)
- `apps/web/src/app/api/admin/kyb/[submissionId]/approve/route.ts`, `…/reject/route.ts` (new)
- `apps/web/src/app/[locale]/account/organization/page.tsx`, `organizations/new/page.tsx` — use `listOwnApplications`
- `apps/web/messages/en.json` — `admin.kyb.errors.*`
- `apps/web/src/__tests__/kyb-review.test.ts`, `helpers/organizations.ts` (new); `organizations-api.test.ts` (claim test adjusted)
- `docs/technical/03`, `04`, `06`, `09`

### `docs/technical/` chapters updated
- **03** — `kyb_submissions.reviewed_at`, fourth migration, what approval and rejection do to the organisation row. **04** — two routes, review rules, sources. **06** — new row "KYB review" (self-review, payout confirmation, audit; no second reviewer / MFA yet). **09** — TASK-008 row (seven PRs). All **Built**; dates already 2026-10-02.

## Size
838 changed lines without docs and the generated snapshot: 117 in tracked files, 721 in new files. Tests and test helpers are 395 of them (`kyb-review.test.ts` 268, helper 111, 16 in the old test). Production code is about 440 lines. Slightly over ~800; if you want it under, `own-applications.ts` with the two page changes (about 120 lines) can be a separate small PR — but the "Submit again" claim path needs it.

## Deviations from the task (and why)
- **`listOwnApplications` extracted from the two pages** (not in the plan): decision 1 changes when "Submit again" is offered, and the same rule is needed by the status page and the prefill. One function, tested in the integration suite.
- **Test helpers in `__tests__/helpers/organizations.ts`**, used by the new suite; the 008b-1 suite keeps its own copies (not refactored, to keep this diff small).
- **Approval also re-inserts the applicant's `ORG_ADMIN` membership** if it is missing (on conflict do nothing).
- **The origin check comes after the role check**, so a non-admin always sees 404, never 403.
- **`kyb.approve` / `kyb.reject` use `entity_type = "kyb_submission"`** with the submission id as `entity_id`; the organisation id is in `data`.
- **Local database:** migration `0003` applied (`pnpm --filter @cherrio/db migrate`).

## New dependencies
- none.

## How to verify
1. `docker compose -f docker-compose.dev.yml up -d`
2. `export DATABASE_URL=postgres://cherrio:cherrio@127.0.0.1:5432/cherrio_dev DATABASE_URL_DIRECT=$DATABASE_URL`
3. `pnpm --filter @cherrio/db migrate`
4. `pnpm --filter web test` → 13 files, 94 passed
5. `pnpm --filter @cherrio/shared test` → 50 passed; `pnpm --filter @cherrio/db test:integration` → 15 passed

## Test results (all from this session)
- `pnpm --filter web test`: `Test Files 13 passed (13)`, `Tests 94 passed (94)`. New suite `kyb-review` (7 tests):
  1. approve a new organisation — status, reviewer, `reviewed_at`, audit data without personal data; the address ending is accepted in upper case;
  2. approve a claim — the row takes every application value (an empty website clears the imported one), `source = REGISTERED`, `claimed_by_user_id`; a user with only a rejected submission is removed and audited; a member without any application stays;
  3. reject a claim — organisation `NONE` and unchanged, membership removed, audit rows, note not in the log; **`listOwnApplications` still returns the rejected claim with the note and `canResubmit`**; "Submit again" with the organisation id is a new claim; a different register number with that id is refused;
  4. reject a new organisation → `REJECTED`, membership kept → resubmit → approve: the row takes the corrected name; a later rejection does not take an approval away;
  5. refused with nothing written — applicant as reviewer, **`ORG_ADMIN` as reviewer** (both routes), wrong address ending, too few characters, short note, empty application, already reviewed;
  6. non-admin, applicant and anonymous get 404 on both routes; unknown and malformed id 404; a localhost origin under `APP_ENV=dev` 403; nothing written;
  7. every error code has a message.
- `organizations-api` (9 tests) passes with the adjusted claim test (rejected claim → `NONE`, same user claims again with the id, then another user).
- `pnpm --filter @cherrio/shared test`: 50 passed. `pnpm --filter @cherrio/db test:integration`: 15 passed (schema rebuilt from `0000`–`0003`).
- **Migration on the existing schema:** local database at `0002` with data → `Migrations complete.`
- **Deliberate break** (line `refuse("self_review")` removed): `Tests 1 failed | 6 passed (7)` — `refused, with nothing written … → expected { status: 200, … } to deeply equal { status: 409, … }`. Restored; full suite 94 passed.
- `pnpm --filter='!@cherrio/contracts' lint`, `typecheck`, `pnpm --filter web check:design`: no errors.

## NOT RUN
- docker build: not needed (no image change — the new migration file is copied by the existing `COPY packages/db/drizzle`).
- E2E (Playwright) — NOT RUN. Two pages changed only in where their query lives (`listOwnApplications`); typecheck and the unit suite cover it, the browser flow is re-run in 008c-2 with "Submit again" end to end.
- GitHub Actions — NOT RUN until pushed.
- Two reviewers deciding the same submission at the same moment — covered by the row lock and the `PENDING` check, not tested with real concurrency.

## Open questions / risks
- **Size** (above).
- **No second reviewer and no admin MFA:** one admin's approval writes the payout address. The typed confirmation guards against a slip, not against a dishonest admin.
- **After a rejected claim the claimant can claim again at once**, and again after each rejection; only "one pending per user" and the rate limit bound it.
- **An admin who is `ORG_MEMBER` (not admin) of the organisation may review it.** Addition C names `ORG_ADMIN`; say if any membership should block.
- **A rejected claim's audit trail is the only trace on the organisation** — the row itself shows nothing of the attempt (by design of decision 1).
- **`eraseUser` still ignores files and pending submissions** (008c-3).

## Suggested commit message
feat(admin): KYB review API — approve applies the application, reject, audited (TASK-008c-1)
