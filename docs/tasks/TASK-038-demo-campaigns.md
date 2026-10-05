# TASK-038 — Demo campaigns for testing (ADR-052)

David, 2026-10-05: "fill dev with test campaigns … publish test/demo campaigns, enter how many, an upper limit per batch … so I can test filters, donation types, speed, scalability, payouts". Decisions (same day): real contracts on Amoy, images generated on the server through fal.ai, batch limit 10.

## Parts
- **038a — create demo campaigns (DB) + badge.** Migration `is_demo boolean not null default false` on `app.campaigns` (backward compatible). Content pool `apps/web/src/lib/demo/pool.ts` (≥ 50 made-up campaigns across all causes and several countries; targets 500–50,000 €). Demo organisation per environment (created on first use, KYB `APPROVED`, owner = the acting admin). `POST /api/admin/demo-campaigns` `{ count 1–10, payoutAddress, durationMode: "mixed" | "short" }` → N `APPROVED` campaigns with an ECB rate snapshot and offchain id, audited; refused unless `APP_ENV` is `local`/`dev`. Admin page `/admin/demo` (form + list of demo campaigns and their status). "Demo" badge on campaign cards (list, landing) and a notice on the campaign page; `isDemo` in the public read model.
- **038b — covers through fal.ai.** `lib/demo/cover.ts`: `fal-ai/nano-banana-pro` (sync `https://fal.run/…`, header `Authorization: Key …`), 4:3, 1K, webp/jpeg → existing `processCoverImage` → `putPublicImage` → `campaign_media` COVER. Called per campaign from the admin page after creation (one request per image, so no request runs into the proxy timeout); progress shown. `FAL_KEY` in `config/deploy.dev.yml` `env.secret` after David's PR adds the name to `.kamal/secrets-common` and the value to GitHub Environment `dev`. Tests with a mocked fetch.
- **038c — publish all.** The publish logic of `PublishPanel` extracted into a reusable client function; "Publish all demo campaigns" on `/admin/demo` publishes every `APPROVED` demo campaign one after another with the Operator wallet (one signature each), then links them once the indexer has them. Tests with the fake EIP-1193 provider.

## Not in scope
Cause/country filters on `/campaigns` (next task, uses the demo data), simulated donors (needs keys), deleting demo campaigns.

## Docs
technical 04 (pages, API), 03 (column), 05 (FAL_KEY), 09; owner guide (new admin action that ends in Operator transactions) + PDF; fundraisers/cherrions guides untouched (admin-only); feedback per part.
