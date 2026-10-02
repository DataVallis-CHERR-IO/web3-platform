# TASK-008b-2 feedback — organisation application: pages and E2E
Status: PARTIAL — everything in scope is implemented and proven locally, but the diff is **940 changed lines** without docs (rule: ~800), so I stop for your decision on where to cut (see "Size"). GitHub Actions is NOT RUN until pushed.

## What I implemented
- **`/en/organizations/new`** — server page + `OrganizationForm` (client).
  - Fields: name, legal name, country (249 countries, names from `Intl.DisplayNames`), register, registration number, website, description, causes, payout address.
  - Five document slots (extract, authorisation, statute, two "other"): a file is uploaded on selection (`POST /api/files/kyb`), shows "Uploading…" / "Uploaded — n KB" / the server's error text, and can be removed (`DELETE`).
  - The two fixed notes: "Upload organisation documents only. Do not upload personal ID documents." and "Payouts can only go to this address. Changing it later needs a new review."
  - Validation in the browser with the shared zod schema, then on the server; errors per field (`organizations.form.fieldErrors.*`), refusals (409) as one message above the button.
  - **Submit again:** `?organization=<id>` — only for the user's own `REJECTED` organisation (as `ORG_ADMIN`); the form is prefilled from their last application, register and number are fixed, and `organizationId` is sent. Anything else redirects to the status page.
- **`/en/account/organization`** — the user's applications, one card per organisation (their latest submission): status chip (waiting for review / verified / not accepted), date, reviewer's note and "Submit again" for `REJECTED`, "Register an organisation" when nothing is pending. Linked from `/en/account`.
- Both pages redirect to `/en` when logged out.
- **`packages/ui`:** `Textarea`, `CheckboxGroup`, `FileField` (tokens only, 3px ink border, radius 0), CSS in `components.css`, READMEs.
- **E2E:** test-only session helper, organisation spec, E2E server on `APP_ENV=local`, Postgres + s3mock + migrate in the `e2e` CI job.
- **Unit test:** dev, uat and prod refuse a localhost origin and referer.

## For David — design-system artifact
New components to add to the CHERR.IO Design System artifact (READMEs are in `packages/ui/design-system/components/<Name>/README.md`):
1. **Textarea** — multi-line Field.
2. **CheckboxGroup** — fieldset with square 24px boxes, checked = `accent` fill with an inset.
3. **FileField** — one document slot: file picker, then state text + remove cell.

They are not in the `/en/dev/ui` gallery yet (left out for size).

## Files changed
- `apps/web/src/app/[locale]/organizations/new/page.tsx`, `OrganizationForm.tsx` (new)
- `apps/web/src/app/[locale]/account/organization/page.tsx` (new); `account/AccountClient.tsx` (link card)
- `apps/web/messages/en.json` — `organizations.form.*`, `account.organization.*`
- `packages/ui/src/components/Textarea.tsx`, `CheckboxGroup.tsx`, `FileField.tsx` (new), `src/index.ts`, `src/styles/components.css`
- `packages/ui/design-system/components/{Textarea,CheckboxGroup,FileField}/README.md` (new)
- `packages/shared/package.json` — export `./organizations`
- `apps/web/e2e/helpers/session.ts`, `apps/web/e2e/organization.spec.ts` (new); `apps/web/playwright.config.ts`
- `.github/workflows/ci.yml` — `e2e` job
- `apps/web/src/__tests__/security.test.ts`; `files-integration.test.ts` (one timeout, see deviations)
- `docs/technical/01`, `04`, `07`, `09`

### `docs/technical/` chapters updated
- **01** — actors (organisation: applying is Built), data-location row. **04** — §4 two pages and the new components, §7 status line. **07** — E2E job, test strategy, counts (web 87, E2E 92, shared 50). **09** — TASK-008 row. All **Built**; dates already 2026-10-02.

## Size — where to cut
Changed lines without docs and the three READMEs: **940** (191 in tracked files, 749 in new files). Largest parts: form 257, messages 92, status page 90, form page 88, E2E spec + helper 148, UI components + CSS 181, CI 29.

- **Option 1 (my proposal): UI components first.** Own PR with `Textarea`, `CheckboxGroup`, `FileField`, CSS, index and READMEs: 181 lines. The rest is then 759. The components have no behaviour of their own and are easy to review alone.
- **Option 2: E2E infrastructure first.** CI job, Playwright config, session helper, origin unit test: about 120 lines; the rest is 820 — still over.
- **Option 3:** keep one PR at 940.

Nothing needs rewriting for option 1 or 2; it is only a matter of which files go into which commit.

## Deviations from the task (and why)
- **`@cherrio/shared/organizations` sub-path export**, used by the form, so the browser bundle does not pull in chain configuration and contract addresses from the package index.
- **The form checks the registration-number rule itself**, in addition to the schema, so a missing number is shown together with the other field errors (see 008b-1 feedback: the schema reports it in a second step).
- **Status is the user's own latest submission**, not `organizations.kyb_status`: after a rejected claim another user may have a pending claim on the same organisation, and the first user must still see "Not accepted". "Submit again" is shown only when the organisation itself is `REJECTED` and the user has nothing pending.
- **`files-integration.test.ts`: timeout of the "10 unattached files" test raised to 30 s.** In one run today, while a build was running too, it exceeded the default 5 s; the abandoned test then held the upload slots and three following tests failed with 503. Two later runs on a quiet machine passed (87/87). The risk exists on a slow CI runner, hence the change.
- **`CLAUDE.md` not changed:** its "Useful commands" still say `CI=1 APP_ENV=dev pnpm test:e2e`. The server's `APP_ENV` is now set by `playwright.config.ts` (`local`), and the run needs `DATABASE_URL` and the Docker services. Suggested line: `cd apps/web && CI=1 pnpm test:e2e   # needs DATABASE_URL, Postgres + s3mock`.
- **Local database:** `pnpm --filter @cherrio/db migrate` (no-op, already at `0002`).

## New dependencies
- none.

## How to verify
1. `docker compose -f docker-compose.dev.yml up -d`
2. `export DATABASE_URL=postgres://cherrio:cherrio@127.0.0.1:5432/cherrio_dev DATABASE_URL_DIRECT=$DATABASE_URL`
3. `pnpm --filter web test` → 12 files, 87 passed
4. `pnpm --filter 'web...' --filter '!@cherrio/contracts' build`
5. `cd apps/web && CI=1 pnpm test:e2e` → 92 passed

## Test results (all from this session)
- `pnpm --filter='!@cherrio/contracts' lint` and `typecheck`: no errors. `pnpm --filter web check:design`: `Design check passed — no violations found.`
- `pnpm --filter web test`: `Test Files 12 passed (12)`, `Tests 87 passed (87)` — twice in a row. (One earlier run: `4 failed | 83 passed`, the timeout described above.) `security.test.ts` has 3 new tests (dev, uat, prod).
- Build: both pages and `/api/organizations` in the route table; `/en/organizations/new` 3.35 kB (213 kB first load), `/en/account/organization` 1.95 kB.
- **E2E, whole suite on `APP_ENV=local`:** `92 passed (1.5m)` — the 86 existing tests plus 6 new (3 × two viewports):
  - logged out: `/en/organizations/new` and `/en/account/organization` redirect to `/en`;
  - logged in: empty status page → form → empty submit shows the field errors → fill → PDF and PNG uploaded ("Uploaded — n KB" twice) → an HTML file as `.pdf` shows "Only PDF, JPEG and PNG files are accepted." → submit → status page shows the organisation and "Waiting for review", no "Register" link; axe: no violations on the empty status page, the filled form and the pending status page.
- **Deliberate break** (session check removed from `/en/account/organization`, rebuilt): `1 failed, 2 passed` — `logged out › /en/account/organization redirects to /en` → `TimeoutError: page.waitForURL: Timeout 10000ms exceeded … navigated to "http://localhost:3000/en/account/organization"`. Restored and rebuilt: `6 passed`.

## NOT RUN
- docker build: not needed (no image change — no Dockerfile, dependency or bundled-script change).
- GitHub Actions — NOT RUN until pushed; the `e2e` job with its two new services and the migrate step is unproven there.
- "Submit again" in the browser — NOT RUN in E2E (no review exists before 008c to reject an application); the API path is covered by the 008b-1 integration tests, the prefill query only by typecheck.
- Dark theme axe on the new pages — NOT RUN (light only).
- `pnpm --filter @cherrio/db test:integration`, indexer and contract tests — NOT RUN; untouched in this PR.

## Open questions / risks
- **Size** (above).
- **Reloading the form loses the uploaded file ids.** The files stay unattached, count toward the limit of 10 and are swept after 24 h; a user who reloads often can hit "too many files".
- **Removing a file does not wait for the server:** if the `DELETE` fails the file stays unattached until the sweep.
- **The `e2e` CI job is now heavier** (two service containers, migrate) and a failing logged-in test blocks the same job as the a11y checks.
- **The session helper signs cookies with a fixed test secret.** It works only against a server started with that secret under `APP_ENV=local`; `e2e/` is excluded from the image by `.dockerignore`.
- **E2E leaves objects in s3mock** (rows are deleted, objects become orphans for the sweep; s3mock is empty after a restart).
- **249 countries in one dropdown** works with type-ahead but is long on a phone.
- The new components carry no demo in `/en/dev/ui`.

## Suggested commit message
feat(web): organisation application form, status page and logged-in E2E (TASK-008b-2)
