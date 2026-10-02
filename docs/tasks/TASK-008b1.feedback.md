# TASK-008b-1 feedback — organisation application: schemas and API
Status: DONE — proven locally. GitHub Actions is NOT RUN until pushed. One point for your decision: the diff is 847 hand-written lines (see "Size").

First half of PR B (split approved). No page yet: nothing a user can see changes. The form, the status page and E2E are TASK-008b-2.

## What I implemented
- **`@cherrio/shared`** (`src/organizations.ts`): `organizationApplicationSchema` (zod), `ORGANIZATION_CAUSES` (the nine approved), `ORGANIZATION_REGISTRIES`, `COUNTRY_CODES` (249 ISO codes), `KYB_DOCUMENT_RULES` + `kybDocumentsComplete`.
  - Payout address: viem `isAddress` (wrong checksum refused, lowercase accepted), output lowercase.
  - Registry number: trimmed, max 64, required unless `NONE`, must be empty for `NONE`. Website: optional, `https://` only.
- **Migration `0002_cold_supreme_intelligence.sql`** (change A):
  ```sql
  ALTER TABLE "app"."kyb_submissions" ADD COLUMN "application" jsonb DEFAULT '{}' NOT NULL;
  CREATE UNIQUE INDEX "kyb_submissions_one_pending_per_submitter" ON "app"."kyb_submissions"
    USING btree ("submitted_by") WHERE "app"."kyb_submissions"."status" = 'PENDING';
  ```
  Backward compatible: it only adds a column with a default and an index; the deployed code never writes `kyb_submissions`.
- **`POST /api/organizations`** — origin check, session, 10/min per user, zod; then one transaction (`lib/organizations/apply.ts`):
  1. per-user advisory lock; a `PENDING` submission of this user → `application_pending`;
  2. organisation by `(registry, registry_id)` (or by `organizationId` for "Submit again"), `FOR UPDATE`:
     - none → **new**: row inserted from the form (`REGISTERED`, `PENDING`);
     - imported, unclaimed, `kyb_status` `NONE` or `REJECTED` → **claim**;
     - `REJECTED` and the applicant is its `ORG_ADMIN` → **resubmission**;
     - everything else (incl. imported with `PENDING`/`APPROVED`) → `organization_exists`;
     - claim and resubmission change **only** `kyb_status = PENDING`; the form data goes to `kyb_submissions.application`;
  3. `org_members` `ORG_ADMIN` (on conflict do nothing);
  4. `kyb_submissions` (`PENDING`, `application`);
  5. files: all given ids must be this user's, unattached, not deleted, and satisfy the document rules, else `files_invalid` and full rollback; storage keys are not changed;
  6. `audit_log` `organization.apply` / `organization.claim`, data = submission id and a resubmission flag only.
  - A unique violation from a parallel request maps to the same code as the check (`application_pending`, `organization_exists`).
  - Responses: 201 `{ organizationId, submissionId, claim }`; 400 `validation_failed` with field names; 409 with a code. Texts: `organizations.errors.*` in `en.json`.

## For TASK-008c (review)
- **On approval, apply `kyb_submissions.application` to the organisation row** (name, legal name, country, website, description, causes, payout address) — for claims and resubmissions the row still holds the old data. For a new organisation row and application are equal.
- A rejected claimant **stays `ORG_ADMIN` in `org_members`** of the imported organisation. When another user's claim is approved, 008c must decide what happens to earlier members (I would remove members whose submissions were all rejected).
- `application` of an old row is `{}` (default); none exists on dev.

## Files changed
- `packages/shared/src/organizations.ts` (new), `src/index.ts`, `test/organizations.test.ts` (new)
- `packages/db/src/schema/organizations.ts`; `packages/db/drizzle/0002_cold_supreme_intelligence.sql`, `meta/0002_snapshot.json`, `meta/_journal.json` (generated)
- `apps/web/src/app/api/organizations/route.ts`, `apps/web/src/lib/organizations/apply.ts`, `errors.ts` (new)
- `apps/web/src/lib/security/rate-limit.ts` — `applicationRateLimiter`
- `apps/web/messages/en.json` — `organizations.errors.*`
- `apps/web/src/__tests__/organizations-api.test.ts` (new)
- `docs/technical/03`, `04`, `09`

### `docs/technical/` chapters updated
- **03** — `kyb_submissions` row (new column, partial unique index), §2.2 (third migration), note "Organisation data before approval" (placed at the end of §2.4). **04** — §7 route, rules, sources. **09** — TASK-008 row (five PRs). All labelled **Built**; dates already 2026-10-02.

## Size
Hand-written changed lines without docs: **847** (42 in tracked files, 805 in new files), of which tests are 459 (`organizations-api.test.ts` 387, shared test 72) and production code 388. The generated `0002_snapshot.json` (2,545 lines) is not counted. This is slightly over ~800; I did not cut tests to get under it. If you want it under the line, the shared schema and its unit tests (183 lines) can be committed as a separate PR first.

## Deviations from the task (and why)
- **Optional `organizationId` in the request**, for "Submit again". Without it an organisation with registry `NONE` cannot be found again, and a resubmission would create a second organisation. With it: the organisation must be `REJECTED`, the applicant its `ORG_ADMIN`, and registry + number must equal the row's; otherwise `resubmission_not_allowed`.
- **Resubmission is audited as `organization.apply`** with `resubmission: true` (the task names only two actions).
- **Name and legal name 2–200 characters, description required, 1–5 causes, 2–5 files** — limits the task does not give.
- **The registry-number rule is reported in a second step.** It spans two fields, and zod evaluates it only when the single fields are valid. So a request with a bad address *and* a missing number first returns only the address. The test states this. The form in 008b-2 uses the same schema and will show it the same way unless I check that rule separately in the form.
- **Local database:** I applied migration `0002` to the local Docker database (`pnpm --filter @cherrio/db migrate`).

## New dependencies
- none (`zod` and `viem` are already dependencies of `@cherrio/shared`).

## How to verify
1. `docker compose -f docker-compose.dev.yml up -d`
2. `export DATABASE_URL=postgres://cherrio:cherrio@127.0.0.1:5432/cherrio_dev DATABASE_URL_DIRECT=$DATABASE_URL`
3. `pnpm --filter @cherrio/db migrate` → `Migrations complete.`
4. `pnpm --filter @cherrio/shared test` → 50 passed
5. `pnpm --filter web test` → 12 files, 84 passed
6. `pnpm --filter @cherrio/db test:integration` → 15 passed

## Test results (all from this session)
- `pnpm --filter @cherrio/shared test`: `Test Files 3 passed (3)`, `Tests 50 passed (50)` (6 new).
- `pnpm --filter web test`: `Test Files 12 passed (12)`, `Tests 84 passed (84)`; `organizations-api` 9 tests:
  new organisation (rows in all four tables + audit, address lowercase, storage keys unchanged) · claim (same row, `PENDING`, still `IMPORTED`, **name / legal name / description / website / causes / payout address unchanged, submission holds the new values**; second claim while pending refused; another user may claim after a rejection) · registered / approved / already claimed → refused, organisation count unchanged, nothing written · second pending application refused by the check **and** by the unique index (direct insert → `kyb_submissions_one_pending_per_submitter`) · files foreign / mixed / deleted / incomplete / unknown id / already attached → `files_invalid`, nothing written · resubmission · registry `NONE` · 401, 403 for a localhost origin under `APP_ENV=dev`, 400 with field names · shared constants equal the DB enums, every error code has a message.
- `pnpm --filter @cherrio/db test:integration`: `Tests 15 passed (15)` (schema re-created from migrations `0000`–`0002`).
- **Migration on the existing schema:** the local database was at `0001` with data; `migrate` → `Migrations complete.`, and the tests above ran on it.
- **Deliberate break** (condition `eq(privateFiles.uploadedBy, userId)` removed): `Tests 1 failed | 8 passed (9)` — `another user's files: expected { status: 201, … } to deeply equal { status: 409, … }`. Restored: `Tests 9 passed (9)`.
- First run of the new suite: `1 failed | 8 passed` — my own wrong expectation about the registry-number rule (see deviations); the test now states the real behaviour.
- `pnpm --filter='!@cherrio/contracts' lint` and `typecheck`: no errors.

## NOT RUN
- docker build: not needed (no image change — no Dockerfile, dependency or bundled-script change; the new migration file is copied by the existing `COPY packages/db/drizzle`).
- GitHub Actions — NOT RUN until pushed.
- E2E (Playwright) — NOT RUN; no page changed (008b-2).
- `pnpm --filter indexer test`, `forge test` — NOT RUN; untouched.
- Two truly parallel requests (the race paths behind the unique violations) — only the index itself is tested, by a direct insert.

## Open questions / risks
- **Registry `NONE` has no duplicate check** (accepted for now): the same organisation can be submitted by several users; only "one pending per user" limits it.
- **Rejected claimants remain members** of the imported organisation (see "For TASK-008c").
- **A rejected organisation with a registry number is blocked for everyone but its `ORG_ADMIN`** (`organization_exists`), until a reviewer or support acts. If an impostor registers a real charity's number first and is rejected, the real charity must contact us — that is the message text.
- **`eraseUser`** deletes the user's `org_members` rows but not submissions or files (008c). After an erase, a rejected organisation has no `ORG_ADMIN` and cannot be resubmitted by anyone.
- **The answer-4 test** (dev/uat/prod refuse a localhost origin): one such assertion is in this suite for `dev`; the full set for all three environments comes with the E2E switch in 008b-2.
- The upload route and this route share the per-user advisory lock, so a user's upload and submit never interleave.

## Suggested commit message
feat(web): organisation application API with claim and resubmission (TASK-008b-1)
