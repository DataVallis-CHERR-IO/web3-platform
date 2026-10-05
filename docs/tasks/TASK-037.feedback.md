# TASK-037 feedback
Status: DONE (Built; Live on dev after merge + deploy)

## What I implemented
- `lib/campaigns/landing.ts`: `pickLandingCampaigns` (pure) and `getLandingCampaigns(db)` on top of `listPublicCampaigns` page 1. Hero = first live campaign in list order (soonest deadline), grid = next live campaigns, max `LANDING_GRID_SIZE` = 4. "Live" = public state `live` only (`ending`, ended states and campaigns without chain data are left out).
- `components/campaigns/PublicCampaignCard.tsx`: the card from `/campaigns` extracted, now used by the list and the landing.
- `app/[locale]/page.tsx`: async server component, `force-dynamic`; hero card with cover (or "No photo yet"), status chip, organisation (+ "Verified"), title link, progress (USDC + EUR target, same labels as the list), "Donate to this campaign", proof link to `#proof`; `HeroEmpty` ("The first campaigns open soon", "Start a campaign" → `/account/campaigns/new`); grid with empty-state texts; "See all campaigns".
- Removed the non-working cause filter buttons and the sample Charity Market Cap ranking (table header kept, one honest line instead).
- Deleted `src/fixtures/landing.ts` and the unused message keys; CSS for the cover image in the hero photo box and the CMC note; removed `.ch-landing-campaigns-filters`.

## Files changed
- apps/web/src/app/[locale]/page.tsx — real data
- apps/web/src/app/[locale]/campaigns/page.tsx — uses the shared card
- apps/web/src/components/campaigns/PublicCampaignCard.tsx — new
- apps/web/src/lib/campaigns/landing.ts — new
- apps/web/src/fixtures/landing.ts — deleted
- apps/web/messages/en.json — new keys, unused keys removed
- packages/ui/src/styles/components.css — hero image, CMC note, filters CSS removed
- apps/web/src/__tests__/landing-campaigns.test.ts, apps/web/e2e/landing.spec.ts — tests
- docs: technical 01, 04, 09, 10; tasks README; this file; spec `TASK-037-landing-real-campaigns.md`; screenshot

## Deviations from the task (and why)
- none. Choice made by the session (product-light): the hero is the soonest-ending live campaign, not the one with the most money. Easy to change in `pickLandingCampaigns`.

## New dependencies
- none

## How to verify
1. `pnpm --filter web test` → 432 passed.
2. On dev after deploy: https://dev.cherr.io/en → the hero shows a live Amoy campaign (title links to its page); "Campaigns raising now" shows up to 4 further live campaigns; no "Surgery for Susan" and no sample charity ranking.

## Test results (real outputs, 2026-10-05, sandbox)
- `pnpm exec vitest run src/__tests__/landing-campaigns.test.ts` → `Tests  5 passed (5)`.
- Deliberate break (`"ending"` counted as live in `pickLandingCampaigns`):
  ```
  × pickLandingCampaigns > takes the first live campaign as hero and the next live ones for the grid, in order
    → expected [ 'b', 'c', 'd' ] to deeply equal [ 'b', 'd' ]
  × getLandingCampaigns (Postgres) > puts the soonest-ending live campaign in the hero and keeps ended ones out
    → expected 'ending' to be 'live' // Object.is equality
  ```
  Restored → `Tests  5 passed (5)`.
- `pnpm --filter web typecheck` / `lint` → clean; `pnpm check:design` → "Design check passed — no violations found."
- `pnpm --filter web test` → `Test Files  48 passed (48)`, `Tests  432 passed (432)` (was 427).
- `pnpm build` → exit 0; `/en` is not in the prerender manifest (rendered per request).
- Playwright (`landing`, `a11y`, `campaign-pages`, `auth-nav`, `licences`, `campaigns` specs, all projects) → `102 passed (1.8m)`.
- Screenshot of the empty state (no published campaign in the local DB): `docs/tasks/screenshots/TASK-037/landing-empty.png`.

## Open questions / risks
- Cause filters on the landing were removed rather than wired; `/campaigns` has no cause filter yet either (candidate for the demo-campaign work, where filters get tested).
- `listPublicCampaigns` reads 24 rows to pick 5 — fine at this size.

## Suggested commit message
feat(web): landing page on real published campaigns (TASK-037)
