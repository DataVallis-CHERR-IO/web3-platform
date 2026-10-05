# TASK-038b feedback
Status: DONE (Built; Live on dev after merge + deploy)

## What I implemented
- `lib/demo/cover.ts`: covers for demo campaigns through **fal's queue API** (`fal-ai/nano-banana-pro`): `startDemoCover` (submit; a campaign that already has a cover is not sent again) and `finishDemoCover` (status → result → download from fal's CDN without credentials → `processCoverImage` → public bucket `campaigns/<id>/<24 hex>.webp` → COVER row → audit `demo.cover_generated`). Prompt from the pool entry's `scene`: documentary photo, 4:3, 1K, no text, no logos, no identifiable faces. Request ids must be UUIDs (no path injection into the fal URL).
- Routes `POST /api/admin/demo-campaigns/:id/cover` and `…/cover/check` (shared `handler.ts`: 404 outside local/dev, for non-admins and non-demo campaigns; 403 cross-site; 400 bad request id; 503 `not_configured` / `generation_failed`).
- Browser loop `admin/demo/covers.ts` (start → poll every 3 s, max 60 polls; stops at once without `FAL_KEY`) and `CoverGenerator.tsx`: runs automatically after a batch is created; the list has a Cover column and "Generate N missing covers".
- `FAL_KEY` in `config/deploy.dev.yml` `env.secret` and in the web "Deploy with Kamal" + files-check steps of `deploy.yml` (name in `.kamal/secrets-common` from David's PR #99, value in GitHub Environment `dev`).

## Deviations from the task (and why)
- The spec said "one request per image"; it became **two kinds of requests per image (start, then checks)** because kamal-proxy cuts responses after 30 s (`config/deploy.yml` `response_timeout: 30`) and Nano Banana Pro can take longer. No request waits for the model.

## New dependencies
- none (fetch + existing sharp pipeline)

## How to verify (on dev after deploy)
1. https://dev.cherr.io/en/admin/demo → create 2 demo campaigns → under the form "Generating cover 1 of 2 with fal.ai…", then "2 covers generated."; the list's Cover column says "Yes".
2. Publish one (admin campaign page → "Publish on Polygon") → its card on https://dev.cherr.io/en/campaigns shows the photo and the "DEMO" tag.
3. If fal fails: "N generated, M failed …" and the "Generate M missing covers" button retries only those.

## Test results (real outputs, 2026-10-05, sandbox)
- `vitest run src/__tests__/demo-covers.test.ts` → `Tests  7 passed (7)` (fake fal fetch, real Postgres, real sharp re-encoding, in-memory store).
- Deliberate break 1 (fal key also sent to the CDN download): `× … submits to fal's queue with the key, polls, then stores a WebP cover and audits it → expected 'Key fal-test-key' to be null`.
- Deliberate break 2 (no "already has a cover" check on start): same test `→ expected 'pending' to be 'done'`. Both restored → `Tests  7 passed (7)`.
- `pnpm --filter web typecheck` / `lint` → 0 errors; `pnpm check:design` → passed; `bash .github/scripts/check-deploy-target.test.sh` → 13 × ok, exit 0.
- `pnpm --filter web test` → `Test Files  50 passed (50)`, `Tests  447 passed (447)`.
- `pnpm build` → exit 0; Playwright `admin-demo` + `landing` → `6 passed (11.6s)`.
- Real fal.ai call: NOT RUN — the sandbox cannot reach fal.ai and must not hold the key; first real run is David's check on dev.

## Docs updated
technical 04 (page + two routes), 05 (`FAL_KEY`), 09.

## Open questions / risks
- Each cover costs about 0.15 $ (fal pricing page, 2026-10-05); the batch limit 10 caps one round at ~1.5 $.
- If two checks for the same campaign finish at the same time, the second image stays in the bucket without a row (the public-bucket orphan sweep is an open item already).

## Suggested commit message
feat(web): fal.ai covers for demo campaigns (TASK-038b, ADR-052)
