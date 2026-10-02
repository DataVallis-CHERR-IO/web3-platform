# TASK-008c-2 feedback — KYB review: admin pages and E2E
Status: DONE — proven locally. GitHub Actions is NOT RUN until pushed.

Second of three PRs of PR C. 597 changed lines without docs, plus the follow-up below.

**Includes the 008c-1 follow-up** (CTO, after review): any membership of the reviewer in the organisation blocks the review — `ORG_ADMIN` or `ORG_MEMBER`, not only `ORG_ADMIN`. Changed in `lockForReview` (`apps/web/src/lib/organizations/review.ts`); the self-review test has an `ORG_MEMBER` case on both routes; technical 04, 06 and 08 and the message text say "member".

## What I implemented
- **`/en/admin/kyb`** — pending applications, oldest first: organisation (the submitted name, linked), country, register and number, submitted at, claim or new. Linked from `/en/admin`.
- **`/en/admin/kyb/[submissionId]`**
  - applicant: display name and email;
  - submitted data in a table; when the organisation row differs from the application (claim, resubmission) a second column **"On CHERR.IO now"** and the line "Approving replaces what is on CHERR.IO now with the submitted values.";
  - payout address in full, checksummed (EIP-55);
  - documents: kind, size, first 12 characters of the SHA-256, download link to `GET /api/admin/files/:id`;
  - earlier applications of the organisation with status, date and note;
  - decision (`ReviewActions`, client): **Approve** opens a dialog with the address and a field for its last 6 characters — the confirm button stays disabled until 6 characters are typed, and the server's refusal is shown in the dialog; **Reject** needs a note of at least 10 characters. After a decision the page shows the result instead of the actions.
- Both pages: `requireRole("PLATFORM_ADMIN")`, 404 for everyone else.
- **`checksumAddress`** in `@cherrio/shared` (viem `getAddress`).
- **E2E** `e2e/kyb-review.spec.ts`; the session helper can create an admin.
- All text under `admin.kyb.*` (next-intl).

## Files changed
- `apps/web/src/app/[locale]/admin/kyb/page.tsx`, `[submissionId]/page.tsx`, `[submissionId]/ReviewActions.tsx` (new)
- `apps/web/src/app/[locale]/admin/page.tsx` — link to the queue
- `apps/web/messages/en.json` — `admin.kyb.*`, `admin.kybLink`
- `packages/shared/src/organizations.ts` — `checksumAddress`
- `apps/web/e2e/kyb-review.spec.ts` (new), `apps/web/e2e/helpers/session.ts` (admin option)
- `apps/web/src/lib/organizations/review.ts`, `apps/web/src/__tests__/kyb-review.test.ts` — 008c-1 follow-up
- `docs/technical/04`, `06`, `07`, `08`, `09`

### `docs/technical/` chapters updated
- **04** — §4 two admin pages; §7 status line. **08** — new §5.1 "Review an organisation application" (the storage check and sweep section is now §5.2). **09** — TASK-008 row. **06** — KYB review row: any membership blocks the review; status now covers the pages. **07** — only the two test counts (web 94, E2E 94). All **Built**; dates already 2026-10-02.

## Deviations from the task (and why)
- **Tables use the design system's ledger classes directly** (`ch-ledger-wrap`, `ch-ledger`), not the `LedgerTable` component, which is built for donation rows (amount, transaction link).
- **The scrollable tables are focusable regions** (`tabIndex`, `role="region"`, a label). axe reported "scrollable region must have keyboard access" on the first run; this fixed it. The same would apply to `LedgerTable` when it is first used on a page — not changed here.
- **"On CHERR.IO now" is shown whenever a field differs**, not by type: a resubmission with unchanged data shows one column.
- **Queue shows the submitted name** (from the application), falling back to the organisation's name; for a claim this is what the claimant typed, not the imported name. The detail page shows both.
- **`docs/technical/07`** touched for two stale counts only (not in your list).

## New dependencies
- none.

## How to verify
1. `docker compose -f docker-compose.dev.yml up -d`
2. `export DATABASE_URL=postgres://cherrio:cherrio@127.0.0.1:5432/cherrio_dev DATABASE_URL_DIRECT=$DATABASE_URL`
3. `pnpm --filter @cherrio/db migrate`
4. `pnpm --filter 'web...' --filter '!@cherrio/contracts' build`
5. `cd apps/web && CI=1 pnpm test:e2e` → 94 passed

## Test results (all from this session)
- `pnpm --filter='!@cherrio/contracts' lint`, `typecheck`: no errors. `pnpm --filter web check:design`: `Design check passed — no violations found.`
- `pnpm --filter web test`: `Test Files 13 passed (13)`, `Tests 94 passed (94)`, run again after the follow-up (same counts; the `ORG_MEMBER` case is inside the existing self-review test). With the old check (`ORG_ADMIN` only) and the new test: `1 failed | 6 passed` in `kyb-review` — `expected { status: 200, … } to deeply equal { status: 409, … }`. `pnpm --filter @cherrio/shared test`: 50 passed.
- **E2E, whole suite:** `94 passed (1.8m)` — the 92 earlier tests plus the review test in two viewports. One test, two browser contexts (applicant, admin):
  1. applicant submits a new organisation → "Waiting for review";
  2. the applicant gets **404** on `/en/admin/kyb` and on the detail URL, and 404 on the document URL;
  3. admin: `/en/admin` → queue → detail; address shown in full; no "On CHERR.IO now" column for a new organisation; axe on queue and detail;
  4. admin downloads the register extract: status 200, `content-disposition: attachment; filename="kyb_registration_extract-…"`, bytes equal to the upload;
  5. admin rejects with a note → page shows "This application has been reviewed." and the Rejected chip;
  6. applicant sees "Not accepted" and the note → **Submit again** → heading "Submit your application again", name and payout address prefilled → changes the legal name, uploads two new documents, submits → "Waiting for review";
  7. admin opens the new application: column "On CHERR.IO now" with the old legal name next to the new one, the earlier note under "Earlier applications"; axe;
  8. Approve dialog: button disabled while empty; `abcdef` → "The characters you typed do not match…"; axe on the open dialog; the right six characters → Approved;
  9. applicant sees "Verified", no "Submit again".
- **Runs before it was green:** (a) axe: `scrollable-region-focusable` on the tables → fixed in the pages; (b) my locator for the status chip matched nothing (the chip's text includes its glyph) → fixed in the test.
- **Deliberate break** (role check removed from the queue page, rebuilt): `✘ … Expected: 404, Received: 200` at `expect((await applicant.goto("/en/admin/kyb"))?.status()).toBe(404)`. Restored and rebuilt, then the full run above.

## NOT RUN
- docker build: not needed (no image change).
- GitHub Actions — NOT RUN until pushed.
- A claim in the browser (imported organisation) — NOT RUN in E2E; the test uses a new organisation and its resubmission. Claims are covered by the 008c-1 integration tests; on the pages only the "claim" label in the queue is untested.
- Dark-theme axe on the admin pages.
- `pnpm --filter @cherrio/db test:integration`, indexer, contracts — NOT RUN; untouched.

## Open questions / risks
- **A decision cannot be undone in the UI.** A wrong approval needs a database fix by David (written into technical 08 §5.1).
- **The queue has no paging or search**; fine for the first applications, not for hundreds.
- **The applicant's email is shown to admins** on the detail page (needed for contact; it is personal data on an admin-only page).
- **Document download opens no preview:** files are attachments only (by design, `nosniff`); the admin opens them locally.
- **E2E on a shared local database:** the queue may contain other pending applications; the test finds its own by a unique name.
- **Build output marks `/en/admin/kyb` as prerendered (●)** like `/en/admin`; at run time it is decided per request — the E2E shows 404 for a non-admin and the page for an admin.

## Suggested commit message
feat(admin): KYB review queue and application page with approve/reject (TASK-008c-2)
