# TASK-008c-3 feedback — KYB: GDPR erase and document retention
Status: DONE — proven locally, including the image. GitHub Actions is NOT RUN until pushed.

**Read first — a deploy-blocking bug from 008b-2 is fixed here.** Since 008b-2, `apps/web/playwright.config.ts` imported a constant from `apps/web/e2e/helpers/session.ts`. `.dockerignore` keeps `apps/web/e2e` out of the build context, and `next build` type-checks `playwright.config.ts`, so **the web image could not be built**: `Type error: Cannot find module './e2e/helpers/session'`. The deploy job builds the same image, so every deploy from a branch that contains 008b-2 fails at "Build and push image" (the running dev site is not affected — a failed build deploys nothing). I did not see it earlier because 008b-2, 008c-1 and 008c-2 ran without a docker build, by the rule "no image change" — the image was affected through a test file. Fix: the constant now lives in `apps/web/playwright.env.ts` (outside `e2e/`), imported by both. If 008b-2 … 008c-2 are already on `dev`, check the last "Deploy" runs.

Suggestion for the rule: also build the image when a file that `next build` type-checks outside `src/` changes (`playwright.config.ts`, `next.config.mjs`, anything it imports).

## What I implemented
- **`eraseUser`** (`packages/db/src/gdpr.ts`), still one transaction, now returns `{ storageKeys }`:
  - closes the user's `PENDING` submission: `REJECTED`, no note, no reviewer, `reviewed_at = now`; claim → organisation back to `NONE`; new organisation → `REJECTED`; an organisation approved earlier stays `APPROVED`; audit `kyb.closed_on_erase` (entity = the submission id, no actor, no data);
  - marks `deleted_at` on the user's unattached files and on files of their non-approved submissions, and returns their storage keys;
  - keeps files of approved submissions, all submission rows and every `review_note`.
  - Doc comment rewritten.
- **`DELETE /api/auth/account`**: after the transaction has committed, deletes the returned objects with `removeStoredObject` — a failure is logged with the error name only (no key, no user) and the object is left for the sweep (its row is already marked, so the orphan rule finds it).
- **`files:sweep`, third rule:** files of submissions `REJECTED` with `reviewed_at` older than 90 days. Row marked first (only rows still not deleted), then the object; `--dry-run` counts and deletes nothing; a second run finds nothing. The CLI prints one more count.
- **Build fix** (above): `apps/web/playwright.env.ts`.

## Files changed
- `packages/db/src/gdpr.ts`, `packages/db/src/index.ts` (type export)
- `apps/web/src/app/api/auth/account/route.ts`
- `apps/web/src/lib/files/sweep.ts`, `apps/web/scripts/files.ts`
- `packages/db/src/__tests__/integration.test.ts`, `apps/web/src/__tests__/files-integration.test.ts`
- `apps/web/playwright.env.ts` (new), `apps/web/playwright.config.ts`, `apps/web/e2e/helpers/session.ts` — build fix
- `docs/technical/03`, `06`, `08`, `09`

Size: 358 changed lines without docs (332 added, 26 removed), tests 185 of them.

### `docs/technical/` chapters updated
- **03** — §2.4: two new rows (`kyb_submissions`, `private_files`), the "not touched yet" sentence removed. **06** — §8 erasure flow and KYB document retention (Built; "deleted when the organisation is removed" stays Planned). **08** — §5.2 sweep: three rules. **09** — TASK-008 row. Dates already 2026-10-02.

## Deviations from the task (and why)
- **`reviewed_at` is set when a pending submission is closed on erase** (no reviewer). Not asked for; it keeps "rejected ⇒ has a review time" true. The files are deleted at once anyway.
- **The close-on-erase rule exists twice:** in `eraseUser` (`packages/db`) and in `rejectSubmission` (`apps/web`), because `packages/db` cannot import from the web app. Both have a test for claim → `NONE` and new → `REJECTED`.
- **Two docker builds instead of one:** the first failed on the 008b-2 bug; the second is the proof.
- **Build fix outside the task scope** (three files), needed to get any image.

## New dependencies
- none.

## How to verify
1. `docker compose -f docker-compose.dev.yml up -d`
2. `export DATABASE_URL=postgres://cherrio:cherrio@127.0.0.1:5432/cherrio_dev DATABASE_URL_DIRECT=$DATABASE_URL`
3. `pnpm --filter @cherrio/db test:integration` → 16 passed
4. `pnpm --filter web test` → 13 files, 96 passed
5. `docker build -t cherrio-web:local .` → rc 0

## Test results (all from this session)
- `pnpm --filter @cherrio/db test:integration`: `Tests 16 passed (16)`. New test (rows only): returned keys = rejected + pending-claim + unattached file, not the approved one; pending claim closed without note, imported organisation `NONE`; approved organisation unchanged; earlier review note kept; audit row without actor and data; a second erase returns no keys; pending application for a new organisation → `REJECTED`.
- `pnpm --filter web test`: `Test Files 13 passed (13)`, `Tests 96 passed (96)`. Two new tests in `files-integration` (real objects in s3mock):
  - **sweep:** rejected 91 days ago → object gone, row marked; rejected 89 days ago, approved (400 days) and pending → object and row kept; the dry run lists exactly the one key and deletes nothing; submission and note stay; second run empty.
  - **account erase through the route** (Privy mocked): unattached, rejected and pending-claim files → object gone and row marked; approved file and another user's file → kept; pending claim closed, organisation `NONE`, audit `kyb.closed_on_erase`.
  - The existing "real run deletes exactly what was listed" test now includes the third list.
- First run of the new sweep test failed with `duplicate key … kyb_submissions_one_pending_per_submitter` — my test gave one user two pending submissions; fixed in the test.
- **Deliberate break** (condition "not approved" removed from `eraseUser`): db suite `1 failed | 15 passed` — `expected [ …(4) ] to deeply equal [ …(3) ]`; web suite `1 failed | 11 passed` — account-erase test, `expected false to be true` (the approved file was deleted). Restored: both green.
- `pnpm --filter='!@cherrio/contracts' lint`, `typecheck`: no errors.
- **docker build**
  - 1st: `build rc=1` — `./playwright.config.ts:7:36 Type error: Cannot find module './e2e/helpers/session'`.
  - 2nd, after the fix: `build rc=0`, image 263 MB (262,758,953 bytes; previous image 261,996,198).
  - In the image: `node apps/web/dist/files.mjs sweep --dry-run` → `files:sweep (dry run — nothing deleted): 0 unattached file(s) older than 24 h, 0 file(s) of applications rejected more than 90 days ago, 0 object(s) without a live row, 0 failed delete(s)`, rc 0; `files.mjs check` → `files:check ok … canary verified`, rc 0; migrations `0000`–`0003` present.
  - An intermediate run of these two commands printed `APP_ENV is not set`: my shell passed the `-e` options as one argument. Repeated with explicit options (output above).
- **E2E after the helper change:** `94 passed (1.2m)`.
- Locally: `pnpm --filter web files:sweep --dry-run` prints the same four counts.

## NOT RUN
- GitHub Actions — NOT RUN until pushed; in particular the deploy job's image build, which is what the fix is for.
- Object delete failure during an erase (storage down) — not simulated; the path is `removeStoredObject`, whose failure branch is only covered by reading.
- Erase with real Privy — mocked.
- Indexer and contract tests — untouched.

## Open questions / risks
- **Deploys since 008b-2** may have failed at the image build (see top).
- **Approved documents are never deleted yet:** ADR-034's "deleted when the organisation is removed" has no trigger, because no organisation removal exists.
- **An erased applicant's approved organisation stays verified with no member left** (`org_members` are deleted by the erase). Who then administers it is a product question for a later task.
- **The 90-day clock uses `reviewed_at`;** rejected submissions from before migration `0003` have none and are never swept by rule 2. None exist on dev.
- **Objects are deleted one by one in the account request** (a user has at most a few dozen files).
- **The sweep still runs by hand**, weekly, until the worker exists.

## Suggested commit message
feat(files): erase and 90-day retention for KYB documents; fix image build broken by the E2E config (TASK-008c-3)
