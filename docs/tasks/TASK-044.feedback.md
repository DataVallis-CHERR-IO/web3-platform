# TASK-044 feedback — sanctioned countries + Terms/Privacy drafts (ADR-054)
Status: DONE (Built — awaiting merge and deploy)

Spec: `docs/tasks/TASK-044-sanctions-terms.md`. Decision: David, 2026-10-05.

## What I implemented
- `packages/shared`: `SANCTIONED_COUNTRY_CODES` = BY, CU, IR, KP, RU, SY; `isSanctionedCountry`; `ALLOWED_COUNTRY_CODES` (243); organisation and campaign zod schemas accept only allowed codes.
- Forms (organisation application, campaign form) list only allowed countries.
- `approveSubmission` (KYB) and `approveCampaign` refuse `sanctioned_country` (409) — also for rows stored before this change (checked before parsing the application; campaign and organisation country).
- `SanctionedCountryNotice` on the admin KYB, organisation and campaign pages.
- `/en/terms`, `/en/privacy` (`components/legal/LegalPage.tsx`, text in `legal.*`), draft 0.1 notice "under legal review", footer links "Terms" and "Privacy".
- Docs: ADR-054, spec, tasks README, technical 04/06/09, fundraisers guide.

## Deviations from the task (and why)
- No IP geo-blocking of "Add money": no IP-to-country source in the app; the onramp partner screens (ADR-054 §2).

## New dependencies
- none

## How to verify
1. `pnpm --filter @cherrio/shared test` → 100 passed; `pnpm --filter web test` → 469 passed.
2. `CI=1 pnpm exec playwright test e2e/legal.spec.ts e2e/licences.spec.ts e2e/organization.spec.ts e2e/kyb-review.spec.ts e2e/campaign-review.spec.ts --retries=0` → 20 passed.
3. On dev: https://dev.cherr.io/en/terms and https://dev.cherr.io/en/privacy (footer links "Terms", "Privacy"); the box "Draft 0.1 — published for transparency while it is reviewed by a lawyer." The country list of https://dev.cherr.io/en/organizations/new no longer offers Russia or Iran.

## Test results (real outputs, this session, 2026-10-05)
```
$ pnpm --filter @cherrio/shared test
      Tests  100 passed (100)
$ pnpm exec vitest run src/__tests__/kyb-review.test.ts src/__tests__/campaign-review.test.ts
      Tests  16 passed (16)
$ pnpm test   (apps/web)
 Test Files  53 passed (53)
      Tests  469 passed (469)
$ CI=1 pnpm exec playwright test e2e/legal.spec.ts e2e/licences.spec.ts e2e/organization.spec.ts e2e/kyb-review.spec.ts e2e/campaign-review.spec.ts --retries=0
  20 passed (1.1m)
$ CI=1 pnpm exec playwright test e2e/legal.spec.ts --retries=0   (after the heading style change)
  6 passed (14.0s)   (incl. a temporary screenshot spec, not committed)
lint: no errors · check:design: passed · typecheck (all packages): no errors
```
Deliberate breaks (restored; suites green again):
```
# SANCTIONED_COUNTRY_CODES emptied
 FAIL  test/campaigns.test.ts > campaign draft schema > duration 7–90 days, cause from the fixed list, ISO country
AssertionError: expected true to be false // Object.is equality
 FAIL  test/organizations.test.ts > sanctioned countries (ADR-054) > six countries under comprehensive sanctions; every other ISO code stays allowed

# campaign approval check disabled
 FAIL  … > a campaign or organisation in a sanctioned country is refused (ADR-054)
AssertionError: expected { status: 200, json: { …(4) } } to deeply equal { status: 409, …(1) }
```
Screenshots of `/en/terms` and `/en/privacy` at 1440 and 390 checked; section headings changed to the app's `font-display uppercase` heading style after the first look.

## docs/technical chapters updated
- 04 (legal pages, sanctioned countries), 06 (§8 sanctions, terms), 09 (TASK-044 row).

## Open questions / risks
- The texts are drafts by the CTO session, not legal advice: a lawyer must review both before the mainnet beta (David).
- The sanctions list changes; review it with every sanctions change.

## Suggested commit message
feat(web,shared): refuse sanctioned countries; Terms of Service and Privacy Policy drafts (TASK-044, ADR-054)
