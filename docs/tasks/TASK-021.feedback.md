# TASK-021 feedback
Status: DONE — Live on dev (PR #198, Deploy 37973269064); David on dev 2026-10-09: "vidim niceee"

## What I implemented
- **Admin menu** (`components/admin/AdminNav.tsx`) rendered by `app/[locale]/admin/layout.tsx` after the role + second-factor gate, so the enrolment / code screens stay bare. Items: Overview, Organisation applications, Campaigns, Organisations, Chain actions, Emergency Pool, Contracts, Audit log, Demo campaigns (only when `demoCampaignsAllowed()`). Reuses the account-menu classes (TASK-058) with a `.ch-admin` variant: a tab row on top at every width — wraps on desktops, scrolls sideways up to 1024 px.
- Every admin page root changed from `ch-container py-12` to `ch-account-page` (the layout provides the container). Removed the button row on `/en/admin` and the two "Back to the admin overview" links.
- **Admin → Audit log** `/en/admin/audit` (`lib/admin/audit.ts`): `listAuditLog` (keyset on `(created_at, id)` desc, left join `users` for the name), `auditEntityTypes` (distinct types for the filter), `auditFilters` (URL → filters, drops unknown type / malformed uuid, `actor=system`), `auditEntityHref`, `auditDataText`. IP never selected.
- "Audit log of this record" link on the admin campaign, organisation and KYB application pages.
- Migration `0023_audit_log_created_at.sql`: `CREATE INDEX "audit_log_created_at_id_idx" ON "app"."audit_log" USING btree ("created_at","id");` (an index only — no column, so it ships with the code; until it exists the page still works, just with a sort).

## Files changed
- `apps/web/src/components/admin/AdminNav.tsx` (new), `apps/web/src/app/[locale]/admin/layout.tsx` — menu + frame.
- `apps/web/src/app/[locale]/admin/audit/page.tsx`, `apps/web/src/lib/admin/audit.ts` (new) — the audit log.
- `apps/web/src/app/[locale]/admin/**/page.tsx` (11 pages) — container class; home without the button row; list pages without back links; three detail pages with the audit link.
- `packages/ui/src/styles/components.css` — `.ch-admin` frame, `.ch-audit-data`.
- `apps/web/messages/en.json` — `admin.nav.*`, `admin.audit.*`; removed unused `admin.*Link`, `admin.comingSoon`, `admin.list.backToAdmin`.
- `packages/db/src/schema/audit.ts`, `packages/db/drizzle/0023_*`, `meta/0023_snapshot.json`, `_journal.json` — index.
- Tests: `apps/web/src/__tests__/admin-audit.test.ts` (new), `apps/web/e2e/admin-audit.spec.ts` (new), `e2e/helpers/session.ts` (`addAuditEntry`), `e2e/admin-hidden.spec.ts` (+ `/en/admin/audit`), `admin-overview`, `admin-emergency-pool`, `campaign-review`, `kyb-review`, `admin-demo` specs (menu instead of removed buttons).
- Docs: technical 01, 03, 04, 06, 09; `docs/CHEATSHEET.md`; `docs/tasks/README.md`; owner guide v1.9 + change log + PDF.

## Deviations from the task (and why)
- First version had the menu as a **side column** like the account area. The existing E2E `admin-view-nav.spec.ts` failed at 1440 px — the campaign view tabs no longer fit on one line next to a 248 px column (real output below). Changed to a tab row on top for the admin area only. Also removed a "My account" item: it wrapped onto its own row at 1440 px (seen in a screenshot) and the header already links the account.
- The "Privy MFA step-up" once listed for TASK-021 in 09 was delivered differently by TASK-049 (own TOTP, ADR-056).

## New dependencies
- none

## How to verify
1. On dev, as admin: https://dev.cherr.io/en/admin → the menu row on top shows "Overview … Audit log … Demo campaigns"; "Overview" is underlined in cherry.
2. "Audit log" → table, newest first. Type `kyb.` into **Action** → only `kyb.*` rows. **Who** → "System" → rows without a person.
3. Click a person's name → "Only actions by <name>. Show all". Click **history** under a subject → only that record.
4. Open a campaign in Admin → Campaigns → "Audit log of this record" → its history (e.g. `campaign.submit`, `campaign.approve`, `campaign.publish_sent`).

## Test results
`pnpm exec vitest run src/__tests__/admin-audit.test.ts src/__tests__/admin-hidden.test.ts src/__tests__/admin-mfa-guard.test.ts src/__tests__/design-classes.test.ts`:
```
 ✓ src/__tests__/admin-hidden.test.ts (9 tests) 1977ms
 ✓ src/__tests__/admin-audit.test.ts (5 tests) 92ms
 ✓ src/__tests__/admin-mfa-guard.test.ts (2 tests) 417ms
 ✓ src/__tests__/design-classes.test.ts (2 tests) 24ms
 Test Files  4 passed (4)
      Tests  18 passed (18)
```
Deliberate break — the keyset condition in `listAuditLog` replaced by `undefined` (sed, then reversed):
```
   × admin audit log (Postgres) > two pages of 50 + 10 with identical timestamps — every row exactly once, stable order 18ms
     → expected [ { …(9) }, { …(9) }, { …(9) }, …(47) ] to have a length of 10 but got 50
```
`pnpm --filter web test` (after the change):
```
 Test Files  72 passed (72)
      Tests  588 passed (588)
```
`pnpm typecheck`, `pnpm lint`: no output (clean). `pnpm check:design`: `Design check passed — no violations found.`

E2E, first run of the admin specs with the side column (the failure that changed the layout):
```
  1) [chromium-1440] › e2e/admin-view-nav.spec.ts:29:1 › admin view tabs: one row per view on a phone, one line on a desktop
    Error: /en/admin/campaigns tab 4 on one line
    Expected: <= 2
    Received:    56
  1 failed
  33 passed (1.9m)
```
After the tab-row layout: `admin-view-nav.spec.ts` + `admin-audit.spec.ts` (+ screenshot spec): `6 passed (23.0s)`. Full suite `CI=1 pnpm exec playwright test --retries=0`:
```
  244 passed (8.0m)
```
Screenshots checked at 1440 and 390 (temporary spec, not committed): `/en/admin`, `/en/admin/audit`, `/en/admin/campaigns` — menu on one row at 1440 with all nine items, sideways tab row at 390, long `data` JSON wraps inside its column.

Owner guide: `npm run owner-guide` → `PDF docs/guides/owner/dist/CHERR.IO-Contracts-Owner-Guide-v1.9.pdf (19 pages)`; `pdftotext` shows the new §10 block "Finding your way and checking what happened (TASK-021)".

## Open questions / risks
- The page reads `data` jsonb as written by each feature. I checked every `insert(auditLog)` call: no secrets or codes are written there (file kinds, tx hashes, ids, stars, notes of reviews). A future feature must keep it that way — the admin view shows `data` as is.
- Timestamps show minutes only (`LocalDateTime`); the `<time datetime>` attribute has the full ISO value.
- Not done on purpose: CSV export, date range, auditing views of the log.

## Suggested commit message
feat(admin): one admin menu + read-only audit log view (TASK-021)
