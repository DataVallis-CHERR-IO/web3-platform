# TASK-042 feedback
Status: DONE (Built; Live on dev after merge + deploy)

## What I implemented
- `lib/campaigns/public.ts`: `CampaignFilters` = `{ causes?, countries? }` arrays; `parseCampaignFilters` reads repeated and comma-separated values, drops unknown ones and duplicates, at most 50 per group; SQL `c.cause in (…)` / `c.country in (…)` in the count, the chain query and the fallback; facets unchanged in shape (cause counts within the chosen countries, country counts within the chosen causes).
- `lib/campaigns/filter-options.ts` (pure): `sortOptions` (count, then label), `visibleOptions` (first 6 + chosen, all when expanded, every match for a search), `normalise` (lower case, no accents), `toggleValue`, `filterQuery`.
- `components/campaigns/CampaignFilters.tsx` (client): sidebar with `<details>` groups (badge with the number chosen), checkboxes styled as square boxes, counts, search above 8 options, "Show all N"/"Show fewer"; optimistic local selection then `router.replace({ pathname: "/campaigns", query }, { scroll: false })`; `aria-busy` dims the list while the server answers; without JS the form's "Apply" button submits. "Filters (n)" button + `Sheet side="bottom"` (new side in `packages/ui` `Sheet`) with "Close", "Clear all", "Show N campaigns".
- `/en/campaigns` page: two-column layout (280px sidebar + results), results bar with count and removable active-filter tags + "Clear all", empty state, pager keeps the filters.
- Styles `.ch-campaigns-body`, `.ch-filter-*`, `.ch-results-bar`, `.ch-active-filter*`, `.ch-sheet-bottom` (tokens only).

## Files changed
- `apps/web/src/lib/campaigns/public.ts`, `apps/web/src/lib/campaigns/filter-options.ts` (new)
- `apps/web/src/components/campaigns/CampaignFilters.tsx` (new), `apps/web/src/app/[locale]/campaigns/page.tsx`
- `packages/ui/src/components/Sheet.tsx`, `packages/ui/src/styles/components.css`, `apps/web/messages/en.json`
- `apps/web/src/__tests__/public-campaigns.test.ts`, `apps/web/src/__tests__/filter-options.test.ts` (new), `apps/web/e2e/campaign-filters.spec.ts`
- docs: this spec, `docs/tasks/README.md`, `docs/technical/04-web-app-and-auth.md`, `docs/technical/09-status-and-roadmap.md`, `docs/guides/donors.md`

## Deviations from the task (and why)
- First version used controlled checkboxes that changed only after the server answered; the E2E caught it ("Clicking the checkbox did not change its state") and it was slow to feel, so the selection is now optimistic local state synced from the server props.

## New dependencies
- none

## How to verify
On dev after the deploy: https://dev.cherr.io/en/campaigns — desktop: "FILTERS" box on the left with "Cause" and "Country", tick e.g. two countries → the list changes at once, tags "Slovenia ×" above the list; phone width: a "FILTERS" button → a sheet from the bottom → "SHOW N CAMPAIGNS".

## Test results (real outputs, this session, 2026-10-05)
`pnpm exec vitest run src/__tests__/public-campaigns.test.ts src/__tests__/filter-options.test.ts src/__tests__/design-classes.test.ts`:
```
 ✓ src/__tests__/public-campaigns.test.ts (18 tests) 490ms
 ✓ src/__tests__/filter-options.test.ts (4 tests) 23ms
 ✓ src/__tests__/design-classes.test.ts (2 tests) 16ms
      Tests  24 passed (24)
```
Deliberate break (chosen options no longer kept visible in `visibleOptions`), then restored:
```
   × filter options > shows the first few, keeps chosen options visible and counts the rest 10ms
      Tests  1 failed | 3 passed (4)
```
`pnpm --filter web test`: `Tests  466 passed (466)`; typecheck exit 0; lint clean; `pnpm check:design` → "Design check passed — no violations found.".
E2E `campaign-filters.spec.ts` (after the optimistic-state fix):
```
  ✓  1 [chromium-1440] › e2e/campaign-filters.spec.ts:46:3 › campaign list filters › filter by cause and country, remove a tag, empty state, unknown values (3.9s)
  ✓  2 [chromium-390] › e2e/campaign-filters.spec.ts:46:3 › campaign list filters › filter by cause and country, remove a tag, empty state, unknown values (3.5s)
```
Full E2E (`CI=1 pnpm exec playwright test --retries=0`): `166 passed (5.7m)`.
Screenshots (1440: sidebar + tags; 390: button + tags; 390: open bottom sheet) checked in the session (temporary spec, not committed).

## docs/technical chapters updated
- `04-web-app-and-auth.md` (`/en/campaigns` filters; TASK-041 container now Live on dev)
- `09-status-and-roadmap.md` (TASK-042 row; TASK-041 Live on dev)

## Open questions / risks
- On phones the open sheet hides the page from assistive tech (Radix modal) — the "Show N campaigns" button carries the live count.
- Each tick is one server render (two small `group by` queries + the list); fine for now, index `campaigns(status, cause, country)` if it gets slow.

## Suggested commit message
feat(web): shop-style campaign filters — sidebar, multi-select, mobile sheet (TASK-042)
