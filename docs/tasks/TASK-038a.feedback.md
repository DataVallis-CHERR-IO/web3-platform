# TASK-038a feedback
Status: DONE (Built; Live on dev after merge + deploy)

## What I implemented
- **ADR-052** (David 2026-10-05: real contracts on Amoy, covers generated on the server through fal.ai, batch limit 10) and spec `TASK-038-demo-campaigns.md` (parts a–c).
- Migration `0010`: `app.campaigns.is_demo boolean not null default false` (backward compatible: old code ignores it).
- `lib/demo/pool.ts`: 59 made-up campaigns (all 9 causes, 6–9 each; SI, HR, AT, IT, DE, BA, RS, MK, CZ, SK, PL, RO, BG, GR, TR, KE; 3,000–50,000 €), each with a cover `scene` for 038b.
- `lib/demo/create.ts`: `demoCampaignsAllowed` (local/dev only), `demoRequestSchema` (count 1–10, address, `mixed`/`short`), `demoDuration` (mixed 1/3/7/14/21/30 days, short 1 day = contract minimum), `demoSeed` (pool order, " (n)" on later rounds), `createDemoCampaigns` (ECB rate, demo organisation "CHERR.IO Demo" + admin as ORG_ADMIN, N APPROVED campaigns with snapshot and offchain id, audit `demo.campaigns_created`).
- `POST /api/admin/demo-campaigns` (404 for non-admins and outside local/dev, 403 cross-site, 400 invalid, 503 no ECB rate, 201).
- `/en/admin/demo` (form + list, linked from `/en/admin` only where allowed). Publishing uses the existing per-campaign "Publish on Polygon" until 038c.
- `isDemo` in the public read model; `CampaignCard` `tag` prop → "Demo" tag in the image corner (list, landing grid) and inline in the landing hero; notice on the campaign page.
- Ride-along: TASK-037 labels flipped to Live on dev (PR #97, Deploy run 37263699073).

## Deviations from the task (and why)
- Demo campaigns may last 1–6 days although the product rule for real campaigns is 7–90 days (`CAMPAIGN_LIMITS`): the contract accepts 1–90 (ADR-030), and fast payout tests need short campaigns (ADR-052 §1). The demo path inserts directly and never goes through the draft form.
- `MAX_ACTIVE_CAMPAIGNS_PER_ORG` (5) does not apply to the demo organisation (same reason: no draft/submit path).
- Text written once with AI into the repo instead of generated per request (no extra LLM key, reviewable content).

## New dependencies
- none

## How to verify (on dev after deploy)
1. https://dev.cherr.io/en/admin → button **"Demo campaigns"** → page "Demo campaigns" with "At most 10 per batch; texts come from a pool of 59 invented campaigns".
2. Enter 2, your MetaMask test address, "All 1 day" → **"Create 2 demo campaigns"** → "2 demo campaigns created. Publish them on chain next." and two rows "Waiting to be published".
3. Open a row → "Publish on Polygon" with the Operator wallet → after linking, the public page shows the notice "Demo campaign: made up for testing on the test network …" and the card in https://dev.cherr.io/en/campaigns has a "DEMO" tag.

## Test results (real outputs, 2026-10-05, sandbox)
- `vitest run src/__tests__/demo-campaigns.test.ts` → `Tests  8 passed (8)`.
- Deliberate break 1 (`demoCampaignsAllowed` returns true for any env):
  ```
  × demo campaign rules > allows only local and dev → expected true to be false
  × createDemoCampaigns (Postgres) > refuses on uat and prod before touching the database → promise resolved "{ …(2) }" instead of rejecting
  × … POST /api/admin/demo-campaigns: 404 for non-admins and on prod, … → expected 403 to be 404
  ```
- Deliberate break 2 (`isDemo: false` on insert): `× … creates APPROVED demo campaigns … → expected false to be true` (`Tests  1 failed | 7 passed (8)`). Both restored → `Tests  8 passed (8)`.
- `pnpm --filter='!@cherrio/contracts' typecheck` / `lint` → clean (after fixing the test's `EcbRate` type); `pnpm check:design` → passed.
- `pnpm --filter web test` → `Test Files  49 passed (49)`, `Tests  440 passed (440)`.
- `pnpm --filter @cherrio/db test:integration` → `Tests  16 passed (16)`; `pnpm --filter worker test` → `Tests  6 passed (6)`.
- `pnpm build` → exit 0. Playwright (`landing` now with a demo campaign, new `admin-demo`, `a11y`, `campaign-pages`, `admin-overview`, `campaigns`) → `88 passed (1.8m)`.

## Docs updated
technical 03 (`is_demo`, read model), 04 (`/en/admin/demo`, API, landing tag), 09; tasks README; ADR-052.

## Open questions / risks
- The demo organisation is found by name; two admins creating the very first batch at the same second could create two. Harmless on dev.
- Demo campaigns cannot be deleted once on chain; a "hide demo campaigns" switch can come later.

## Suggested commit message
feat(web,db): demo campaigns for testing on dev — admin batch, is_demo, Demo tag (TASK-038a, ADR-052)
