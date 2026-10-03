# TASK-030 feedback
Status: DONE (Built; Live on dev after the deploy and David's test)

## What I implemented
- ADR-039 (campaign media) in `docs/03-DECISIONS.md`, from David's decisions of 2026-10-03.
- Up to **10 gallery images** per campaign, processed by the cover pipeline (magic bytes, ≤ 5 MB, re-encoded to WebP, metadata removed).
- Up to **3 YouTube/Vimeo links**: https only, exact hosts and a strict id format. Only `youtube:<id>` / `vimeo:<id>` is stored.
- Up to **5 public PDFs ≤ 20 MB**, stored unchanged in the public bucket after a `%PDF-` check.
- Media can be added and removed in **every** campaign status, because nothing about media is on-chain. The cover is never touched by these routes.
- The limits are enforced under a per-campaign advisory lock, so parallel uploads cannot pass them. Over a limit the uploaded object is removed again.
- Platform-admin takedown, in any status.
- Audit entries: `campaign.media_add`, `campaign.media_remove`, `campaign.media_takedown`.
- UI:
  - a "Photos, videos and documents" section on `/en/account/campaigns/[id]`;
  - a Media section with takedown dialogs on `/en/admin/campaigns/[id]`;
  - all text goes through next-intl.
- Migration `0005_nappy_dark_phoenix.sql`. It only adds: enum values `media_kind.DOCUMENT` and `storage_provider.EXTERNAL`, and the nullable columns `campaign_media.label`, `size_bytes` and `created_by` (FK to users).
- Docs: technical 01, 03, 04, 05, 06, 07, 08 (new runbook §5.1c "Take down campaign media"), 09; `guides/fundraisers.md`; `tasks/README.md`; TASK-029 §2 now points here.

## Files changed
- `docs/03-DECISIONS.md` — ADR-039
- `docs/tasks/TASK-030-campaign-media.md` — spec
- `packages/db/src/schema/{enums,campaigns}.ts`, `packages/db/drizzle/0005_*`, `meta/*` — schema + migration
- `packages/shared/src/campaign-media.ts` (+ index, package.json export), `packages/shared/test/campaign-media.test.ts` — limits, video URL parsing, PDF label
- `apps/web/src/lib/campaigns/{media,media-view,media-route}.ts`, `route.ts`, `errors.ts` — logic and route helpers
- `apps/web/src/lib/media/public-store.ts` — `putPublicPdf`
- `apps/web/src/lib/security/rate-limit.ts` — media limiter (30/min/user)
- `apps/web/src/app/api/campaigns/[id]/media/**`, `apps/web/src/app/api/admin/campaigns/[id]/media/[mediaId]/route.ts` — routes
- `apps/web/src/app/[locale]/account/campaigns/[id]/{page,CampaignMediaManager}.tsx`, `admin/campaigns/[id]/{page,MediaTakedown}.tsx` — UI
- `apps/web/next.config.mjs` — `middlewareClientMaxBodySize: "21mb"` so a 20 MB PDF fits
- `apps/web/messages/en.json` — texts
- `apps/web/src/__tests__/campaign-media.test.ts`, `apps/web/e2e/campaign-media.spec.ts` — tests
- docs listed above

## Deviations from the task (and why)
- `packages/shared` is compiled without DOM/Node types, so `parseVideoUrl` declares the minimal `URL` shape it uses instead of adding a lib.
- Size: about 1,400 added lines including the spec, docs and tests. The production code alone is under the ~800-line guideline. I kept it in one PR because the parts do not work separately.

## New dependencies
- none

## How to verify
1. `export DATABASE_URL=postgres://cherrio:cherrio@127.0.0.1:5432/cherrio_dev`
2. `pnpm --filter @cherrio/shared test`, `pnpm --filter web test`, `pnpm --filter @cherrio/db test:integration`
3. `cd apps/web && CI=1 pnpm exec playwright test --retries=0`
4. On dev, after the deploy:
   - as the organisation, open My account → Campaigns → the campaign and add a photo, a YouTube link and a PDF; the PDF link opens in the browser;
   - as a platform admin, open Admin → Campaigns → the campaign → Media → Remove → confirm; the item is gone and its URL returns 404.

## Test results (this session, 2026-10-03)
- typecheck (all packages except contracts): pass, after the `URL` typing fix in shared
- lint: pass
- `@cherrio/shared`: Test Files 6 passed (6), Tests 83 passed (83)
- `web`: Test Files 24 passed (24), Tests 152 passed (152)
- `@cherrio/db` integration: Tests 16 passed (16)
- `check:design` (apps/web): "Design check passed — no violations found."
- build `web...`: apps/web build Done. The turbo graph's `@cherrio/contracts#build` fails here because Foundry is not installed in this sandbox; CI builds it.
- E2E: `112 passed (2.4m)`
- Deliberate breaks:
  - **Limit checks removed:** `limits: 10 images, 3 videos, 5 PDFs …` failed with `expected { status: 201, … } to deeply equal { status: 409, … }`, giving `Tests 1 failed | 5 passed (6)`.
  - **`%PDF-` check removed:** `refuses: HTML as .pdf …` failed with `expected { status: 201, … } to deeply equal { status: 400, … }`, giving `Tests 1 failed | 5 passed (6)`.
  - Both restored: `Tests 6 passed (6)`.

## Open questions / risks
- PDFs are public and not reviewed (ADR-039). A PDF can carry metadata or scripts. It is served from the bucket origin, never the app origin. There is no automatic scanning.
- Showing the media to visitors on the public campaign page comes with TASK-011.
- There is no sweep for objects whose delete failed (same as the cover, open item in 09).

## Suggested commit message
feat(campaigns): gallery images, video links and public PDFs for campaigns (TASK-030, ADR-039)
