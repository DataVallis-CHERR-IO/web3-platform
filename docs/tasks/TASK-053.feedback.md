# TASK-053 feedback
Status: DONE

## What I implemented
- `lib/campaigns/public.ts`: `CampaignFilters.q`, `parseCampaignFilters` reads `q`; `listPublicCampaigns({ sort })` with per-sort inner/outer ORDER BY (`SORT_ORDER`), page keys `k_published` and `k_raised`; search condition `c.title ILIKE … OR o.name ILIKE …` (shared `containsPattern` from `lib/admin/listing.ts`); count and facet queries join the organisation.
- `lib/campaigns/filter-options.ts` (client-safe): `CAMPAIGN_SORTS`, `DEFAULT_CAMPAIGN_SORT`, `MAX_SEARCH_LENGTH`, `parseCampaignSort`, `ListState`, `listQuery` (one place that builds every list URL).
- `components/campaigns/CampaignListControls.tsx` (new): GET form with search box + "Search" button and native "Sort by" select.
- `components/campaigns/CampaignFilters.tsx`: `keep` prop — a filter change keeps search and sort (also as hidden fields in the no-JS form).
- `app/[locale]/campaigns/page.tsx`: reads `q`/`sort`, search tag, "Clear all" keeps the order, pager keeps everything.
- `packages/ui/src/styles/components.css`: `.ch-list-*` (tokens only; search row and select both 54 px tall; select full width ≤ 640 px).
- `messages/en.json`: `campaignPage.controls.*`.

## Files changed
- `apps/web/src/lib/campaigns/public.ts`, `apps/web/src/lib/campaigns/filter-options.ts`
- `apps/web/src/components/campaigns/CampaignListControls.tsx` (new), `apps/web/src/components/campaigns/CampaignFilters.tsx`
- `apps/web/src/app/[locale]/campaigns/page.tsx`, `apps/web/messages/en.json`, `packages/ui/src/styles/components.css`
- Tests: `apps/web/src/__tests__/public-campaigns.test.ts` (+3), `apps/web/src/__tests__/filter-options.test.ts` (+2), `apps/web/e2e/campaign-search-sort.spec.ts` (new), `apps/web/src/__perf__/campaign-lists.perf.ts` (+4 cases)
- Docs: `docs/technical/04` (`/en/campaigns` row), `09`, `docs/guides/donors.md`, `docs/tasks/README.md`, spec + this file

## Deviations from the task (and why)
- none

## New dependencies
- none

## How to verify
1. https://dev.cherr.io/en/campaigns → above the list "Search campaigns" and "Sort by" (Ending soon / Newest / Most raised).
2. Choose "Most raised" → the URL gets `?sort=raised`, campaigns still raising come first, the one with the most raised at the top.
3. Type part of a campaign title or an organisation name, press Enter → only matching campaigns, a tag “…” above the list; click its × → the search is gone, the order stays.

## Test results
Screenshots (temporary, not committed) at 1440 and 390: search box and select on one line on desktop, stacked full width on a phone under "Filters (1)".

```
pnpm --filter web test                      → Test Files 59 passed (59), Tests 516 passed (516)
pnpm lint / tsc --noEmit / pnpm check:design → clean / clean / "Design check passed — no violations found."
CI=1 pnpm exec playwright test e2e/campaign-search-sort.spec.ts e2e/campaign-filters.spec.ts e2e/campaigns.spec.ts \
  e2e/landing.spec.ts e2e/campaign-card-layout.spec.ts e2e/a11y.spec.ts --retries=0
  84 passed (2.6m)
```

Speed, 10,000 campaigns (`DATABASE_URL=…/cherrio_perf pnpm --filter web perf:campaigns`, median of 7):
```
[perf] /campaigns page 1                        28 ms  (budget 150)
[perf] /campaigns sort newest                 20.7 ms  (budget 150)
[perf] /campaigns sort most raised            24.8 ms  (budget 150)
[perf] /campaigns search                      45.9 ms  (budget 150)
[perf] filter facets (search)                 42.6 ms  (budget 100)
      Tests  16 passed (16)
```

Deliberate break 1 — `listQuery` drops the sort:
```
× list URL (TASK-053) > carries filters, search, a non-default sort and the page
      Tests  1 failed | 5 passed (6)
```
Deliberate break 2 — "Most raised" sorted ascending:
```
× public campaign read model (Postgres) > sorts: ending soon (default), newest, most raised — live campaigns always first
AssertionError: expected [ …(4) ] to deeply equal [ …(4) ]
      Tests  1 failed | 20 passed (21)
```
Deliberate break 3 — search pattern without escaping (`%` matches anything):
```
× public campaign read model (Postgres) > searches the title and the organisation name, case-insensitive, % and _ literal, with the other filters
AssertionError: expected [ …(6) ] to deeply equal [ Array(1) ]
      Tests  1 failed | 20 passed (21)
```
All restored → `Tests  27 passed (27)`.

## Open questions / risks
- Search is case-insensitive but not accent-insensitive ("Čebelarji" is not found by "cebelarji"). Adding `unaccent` needs a migration and the extension on the server — only if David wants it.

## Suggested commit message
feat(web): search and sort on the public campaign list (TASK-053)
