# TASK-039 feedback
Status: DONE (Built; Live on dev after merge + deploy)

## What I implemented
- `apps/web/src/lib/campaigns/public.ts`: `CampaignFilters`, `parseCampaignFilters` (URL → `{ cause?, country? }`, unknown values dropped, first value of a repeated parameter), `listPublicCampaigns(db, { page, cause, country })` (filter in the count, the chain query and the app-only fallback), `listCampaignFacets(db, filters)` (causes counted within the chosen country, countries counted within the chosen cause; causes in the fixed `ORGANIZATION_CAUSES` order).
- `/en/campaigns` (`apps/web/src/app/[locale]/campaigns/page.tsx`): "Filter campaigns" section — cause chips as links with counts and `aria-current`, country `<select>` in a plain GET form with "Show" (no JavaScript needed; a hidden field keeps the cause), result count (`role="status"`), "Clear filters"; empty state "No campaigns match these filters." + "Show all campaigns"; pager links keep the filters. A filter value from the URL that no published campaign uses still shows as chosen (count 0).
- `packages/ui/src/styles/components.css`: `.ch-filters`, `.ch-filter-row`, `.ch-filter-label`, `.ch-filter-chips`, `.ch-filter-chip` (+ `[aria-current]` = ink ground), `.ch-filter-select`, `.ch-filter-summary` — tokens only, radius 0.
- `apps/web/messages/en.json`: `campaignPage.filters.*`.

## Files changed
- `apps/web/src/lib/campaigns/public.ts` — filters + facets
- `apps/web/src/app/[locale]/campaigns/page.tsx` — filter UI
- `apps/web/messages/en.json` — strings
- `packages/ui/src/styles/components.css` — filter styles
- `apps/web/src/__tests__/public-campaigns.test.ts` — 4 new tests
- `apps/web/e2e/campaign-filters.spec.ts` — new E2E
- `docs/tasks/TASK-039-campaign-filters.md`, `docs/tasks/README.md`, `docs/technical/04-web-app-and-auth.md`, `docs/technical/09-status-and-roadmap.md`, `docs/guides/donors.md`

## Deviations from the task (and why)
- none. Sorting and search stay out (follow-ups).

## New dependencies
- none

## How to verify
1. `pnpm --filter web test` (needs `DATABASE_URL`) → 456 passed.
2. `cd apps/web && pnpm build && CI=1 pnpm exec playwright test e2e/campaign-filters.spec.ts --retries=0` → 2 passed.
3. On dev after the deploy: https://dev.cherr.io/en/campaigns → section with "All causes" and cause buttons with counts; click one → the URL gets `?cause=…`, only that cause is listed; choose a country, click **Show** → `?cause=…&country=…`; a combination with nothing → "No campaigns match these filters."

## Test results (real outputs, this session, 2026-10-05)
`pnpm exec vitest run src/__tests__/public-campaigns.test.ts`:
```
 ✓ src/__tests__/public-campaigns.test.ts (18 tests) 343ms
      Tests  18 passed (18)
```
Deliberate break 1+2 (any cause accepted in `parseCampaignFilters`; fallback query uses `publicWhere` without the filter), then restored:
```
   × public campaign read model (Postgres) > parses filters from the URL and drops unknown values 12ms
   × without the indexer's chain views > the fallback list keeps the cause and country filter (TASK-039) 2ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯
```
`pnpm --filter web test` (full suite): `Tests  456 passed (456)` — five runs in a row. The very first full run after the local E2E run reported `1 failed | 455 passed (456)`; its name was not captured and it did not reproduce in five reruns (the local E2E run leaves rows in the shared DB, HANDOFF §9 mentions `app.fx_rates`). Watch CI.

E2E (`CI=1 pnpm exec playwright test e2e/campaign-filters.spec.ts e2e/campaign-pages.spec.ts e2e/landing.spec.ts --retries=0`):
```
  ✓  6 [chromium-390] › e2e/landing.spec.ts:39:3 › landing page › shows a real live campaign and no sample data (1.1s)

  6 passed (24.6s)
```
Deliberate break 3 (hidden `cause` field removed from the country form, rebuilt), then restored:
```
  ✘  1 [chromium-1440] › e2e/campaign-filters.spec.ts:36:3 › campaign list filters › cause chips, country form, empty state and unknown values (7.6s)
    Error: expect(page).toHaveURL(expected) failed
    Expected pattern: /\/en\/campaigns\?cause=climate&country=PW$/
    Received string:  "http://localhost:3000/en/campaigns?country=PW"
  1 failed
```
`pnpm --filter web typecheck` / `lint`: clean. `pnpm check:design`: "Design check passed — no violations found."

## docs/technical chapters updated
- `04-web-app-and-auth.md` (route table `/en/campaigns`, read-model paragraph)
- `09-status-and-roadmap.md` (TASK-039 row)

## Open questions / risks
- Facets run two `group by` queries per page view over published campaigns — fine for hundreds; an index on `campaigns(status, cause, country)` if `/campaigns` gets slow.
- Demo campaigns (ADR-052) count in the facets like any published campaign (they are real published campaigns on dev).

## Suggested commit message
feat(web): cause and country filters on the campaign list (TASK-039)
