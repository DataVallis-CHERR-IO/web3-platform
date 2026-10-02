# TASK-010a feedback — campaign drafts, cover image, organisation pages
Status: PARTIAL — everything in scope is implemented and green locally, but the diff is **1,665 changed lines** without lockfile, snapshot and docs (limit ~1,300), so I stop for your decision (see "Size"). GitHub Actions is NOT RUN until pushed; the image is built only by CI.

## Steps for David

Before the merge to `dev`:
1. Hetzner Console → Object Storage → bucket **`cherrio-public-dev`**, location `nbg1`, **public read**. The existing access key is used (same `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`); if that key does not cover the new bucket, tell me — then separate secrets are needed, which this PR does not have.
2. Check the literal in `config/deploy.dev.yml`: `S3_PUBLIC_BASE_URL: https://cherrio-public-dev.nbg1.your-objectstorage.com`. I wrote it from the bucket name and location; I could not test it. If Hetzner shows a different public URL for the bucket, change that line.

After the merge and deploy:
3. CI: "Image build (web)" must be green, including the new line `sharp loads` in the step "Bundled scripts and sharp load (web)". This is the first proof that the image library works on Alpine.
4. On dev, as `ORG_ADMIN` of a verified organisation: `/en/account/campaigns` → "Start a campaign" → save a draft → upload a cover.
5. **Open the uploaded cover's public URL** (right-click the image → open in a new tab; it must be `https://cherrio-public-dev.nbg1.your-objectstorage.com/campaigns/<id>/<random>.webp`):
   - it loads **without** login, in a private window;
   - it is WebP;
   - optional: download it and check that it has no EXIF (`exiftool file.webp` shows no GPS, camera or date).
   - If it returns 403: the bucket is not public-read, or Hetzner ignores the object ACL — tell me which.
6. Replace the cover once; the first URL must then return 404.
7. Locally, if you want the public bucket to exist after a fresh start: `docker compose -f docker-compose.dev.yml up -d` re-creates `s3mock` with both buckets. (The tests create the bucket themselves if it is missing.)

## What I implemented
- **ADR-035…038** in `docs/03-DECISIONS.md`, after ADR-034, text copied from the task file.
- **Migration `0004_ambiguous_karen_page.sql`**: `campaigns.submitted_at`, `reviewed_at`, `reviewer_id` (→ users), `publish_tx_hash` (varchar 66, check `^0x[0-9a-f]{64}$`), `deadline`, `deployed_at`; enum value `storage_provider = 'HETZNER_PUBLIC'`. Only additions.
- **`@cherrio/shared`** (`campaigns.ts`): `campaignDraftSchema` (title 5–120, story 50–10,000, cause, country, whole euros 100–1,000,000, duration 7–90), `MAX_ACTIVE_CAMPAIGNS_PER_ORG = 5`, `slugify`.
- **Draft API**
  - `POST /api/campaigns`, `PATCH /api/campaigns/:id`, `POST /api/campaigns/:id/submit`: origin check, session, 10/min per user.
  - Only an `ORG_ADMIN` of the organisation (anyone else gets 404), and only while the organisation is `APPROVED`.
  - Story stored as `{ "format": "plain", "text": … }`; target as integer cents.
  - Edits only in `DRAFT` / `REJECTED`. The slug follows the title until the first submit (`submitted_at`), then never changes; it is unique (`-2`, `-3`, …).
  - Submit: needs a cover; refused when the organisation has 5 campaigns in `PENDING_REVIEW`, `APPROVED` or `DEPLOYED` (per-organisation lock in the transaction); audit `campaign.submit`.
- **Cover image** — `POST /api/campaigns/:id/cover`: `Content-Length` required, ≤ 5 MB, JPEG/PNG/WebP by magic bytes, re-encoded with **sharp** to WebP (EXIF orientation applied, max 1600 px wide, not enlarged, at most 40 megapixels input), stored as `campaigns/<id>/<24 random hex>.webp` in the public bucket with `image/webp` and an immutable cache header; `campaign_media` row (`COVER`, `HETZNER_PUBLIC`, key in `cid`); the replaced object is deleted after the row change.
- **Pages:** `/en/account/campaigns` (list with status), `/en/account/campaigns/new`, `/en/account/campaigns/[id]` (form as `DRAFT` / `REJECTED` with the reviewer's note; read-only otherwise); a "Campaigns" link on the organisation status page for verified organisations.
- **Config:** `S3_PUBLIC_BUCKET`, `S3_PUBLIC_BASE_URL` in `config/deploy.dev.yml`; second s3mock bucket in compose and in both CI jobs; `.env.example`; CI "Image build (web)" also runs `require('sharp')` in the image.

## Size — where to cut
1,665 changed lines (222 in tracked files, 1,443 in new files). 77 of them are `LabeledSelect` moved out of `OrganizationForm.tsx` unchanged. Tests are about 480 lines.

The clean cut is the one from my first plan; nothing needs rewriting, it is only which files go into which commit:
- **010a-1 — data, API, cover image (~910 lines):** migration, ADRs, `packages/shared` schema and tests, `lib/campaigns/drafts.ts`, `errors.ts`, `route.ts`, the four API routes, `lib/media/*`, config and CI, `campaign-drafts.test.ts` and the test helper, the `campaigns.errors.*` messages.
- **010a-2 — pages and E2E (~750 lines):** `CampaignForm.tsx`, the three pages, `lib/campaigns/own.ts`, `LabeledSelect.tsx`, the remaining messages, the link on the organisation page, `e2e/campaigns.spec.ts` and the E2E helper.

Or keep one PR at 1,665.

## Files changed
- `docs/03-DECISIONS.md`
- `packages/db/src/schema/campaigns.ts`, `enums.ts`; `packages/db/drizzle/0004_ambiguous_karen_page.sql`, `meta/*` (generated)
- `packages/shared/src/campaigns.ts` (new), `src/index.ts`, `package.json` (sub-path export), `test/campaigns.test.ts` (new)
- `apps/web/src/lib/campaigns/drafts.ts`, `errors.ts`, `route.ts`, `own.ts` (new)
- `apps/web/src/lib/media/image.ts`, `public-store.ts` (new)
- `apps/web/src/app/api/campaigns/route.ts`, `[id]/route.ts`, `[id]/submit/route.ts`, `[id]/cover/route.ts` (new)
- `apps/web/src/app/[locale]/account/campaigns/page.tsx`, `new/page.tsx`, `[id]/page.tsx`, `CampaignForm.tsx` (new); `account/organization/page.tsx` (link)
- `apps/web/src/components/LabeledSelect.tsx` (moved out of `organizations/new/OrganizationForm.tsx`)
- `apps/web/messages/en.json` — `campaigns.*`
- `apps/web/src/__tests__/campaign-drafts.test.ts` (new), `helpers/organizations.ts`; `apps/web/e2e/campaigns.spec.ts` (new), `e2e/helpers/session.ts`
- `apps/web/package.json`, `pnpm-lock.yaml` — `sharp`
- `config/deploy.dev.yml`, `docker-compose.dev.yml`, `.github/workflows/ci.yml`, `apps/web/.env.example`
- `docs/technical/03`, `04`, `05`, `06`, `07`, `09`, `docs/CHEATSHEET.md`, `docs/tasks/README.md`

### `docs/technical/` chapters updated
- **03** — `campaigns` (new columns, story format), `campaign_media.storage`, fifth migration. **04** — §4 two page rows, §7 four routes. **05** — §4.1 env row, new §4.4 "Public media storage" (old §4.4 is now §4.5). **06** — new row "Public campaign media" (metadata stripping, public-by-design). **07** — CI image job (sharp check), test counts. **09** — TASK-010 row (In progress), open item "no sweep for the public bucket". **CHEATSHEET** §6.1 — public bucket.
- Not yet (they belong to 010b / 010c): technical 01 (campaign lifecycle), 02 (who calls `createCampaign`), 08 (review and publish).
- Everything new is labelled **Built**. Dates already 2026-10-02.

## Deviations from the task (and why)
- **`lib/media/` has its own small S3 client** (same credentials through `getS3Config`), instead of the private files' `ObjectStore`: a public object needs a content type, a cache header and a public ACL, and the private-file code is not to be changed.
- **`ACL: public-read` is sent with every object.** On Ceph-based storage a public bucket does not always make its objects public. s3mock ignores it; step 5 shows whether Hetzner honours it.
- **No separate rate limiter:** the draft routes share the 10/min per user limiter of the organisation application.
- **The cover is uploaded only after the first save** (the route needs the campaign id). The form says so.
- **`LabeledSelect` moved** to `apps/web/src/components/` so the campaign form can use it; no change in behaviour (the organisation E2E still passes).
- **Lockfile:** besides the `sharp` entry (0.35.5, already present as an optional dependency of Next), pnpm re-resolved the `viem` peer inside two transitive wallet-connector entries (2.56.9 → 2.56.0). I did not ask for that; it comes from `pnpm add`. `apps/web` itself does not depend on `viem` yet.
- **Local database:** migration `0004` applied (`pnpm --filter @cherrio/db migrate`).
- **The tests create the public bucket in s3mock** with one `PUT` if it is missing, because I may not restart the container to pick up the new compose setting. s3mock itself must run; without it the suite fails.

## New dependencies
- `sharp@^0.35.5` (apps/web) — decode, resize and WebP-encode cover images and drop all metadata (ADR-037). Prebuilt binaries per platform, including Alpine/musl; no install script. Reasons and alternatives are in the plan.

## How to verify
1. `docker compose -f docker-compose.dev.yml up -d`
2. `export DATABASE_URL=postgres://cherrio:cherrio@127.0.0.1:5432/cherrio_dev DATABASE_URL_DIRECT=$DATABASE_URL`
3. `pnpm --filter @cherrio/db migrate`
4. `pnpm --filter @cherrio/shared test` → 56 passed; `pnpm --filter web test` → 14 files, 104 passed; `pnpm --filter @cherrio/db test:integration` → 16 passed
5. `pnpm --filter 'web...' --filter '!@cherrio/contracts' build`, then `cd apps/web && CI=1 pnpm test:e2e` → 102 passed

## Test results (all from this session)
- `pnpm --filter @cherrio/shared test`: `Tests 56 passed (56)` (6 new: validation limits, slug).
- `pnpm --filter web test`: `Test Files 14 passed (14)`, `Tests 104 passed (104)`. New suite `campaign-drafts` (8 tests):
  - create → `DRAFT`, cents, story JSON, slug without accents, creator; `beneficiary_address` and `offchain_id` empty;
  - create refused: anonymous 401; stranger and `ORG_MEMBER` 404; organisation not approved 409; invalid input 400 with the four field names; nothing written;
  - edit by a second `ORG_ADMIN`; unique slugs; slug follows the title before the first submit; stranger 404;
  - **cover:** a 2400×1200 JPEG with EXIF (copyright marker, GPS) → the stored object, read back over its public URL without credentials, is WebP 1600×800 with no EXIF and no XMP, and neither the marker nor the string `Exif` appears in its bytes; key matches `campaigns/<id>/<24 hex>.webp`; a PNG replacement is not enlarged, leaves one row, and the first URL returns 404;
  - cover refused: HTML as `.jpg` 400; right signature but not an image 400; over 5 MB 413 (also with a lying `Content-Length`); no `Content-Length` 411; somebody else's campaign 404;
  - submit: without cover `cover_required`; then `PENDING_REVIEW`, `submitted_at`, audit; edit, cover and second submit refused; after a rejection the edit keeps the slug and the campaign can be submitted again;
  - limit: with 4 active campaigns the 5th submit passes, the next is refused (`too_many_active`); `REJECTED` ones do not count;
  - every error code has a message.
- First run of that suite: `1 failed | 7 passed` — my own wrong expectation about a slug that had become free; the test now states the real behaviour.
- `pnpm --filter @cherrio/db test:integration`: `Tests 16 passed (16)` (schema rebuilt from `0000`–`0004`).
- **Migration on the existing schema:** local database at `0003` with data → `Migrations complete.`
- **Deliberate break** (organisation-membership check removed from `createDraft`): `Tests 1 failed | 7 passed (8)` — `create is refused … → expected { status: 201, … } to deeply equal { status: 404, … }`. Restored: 8 passed.
- `pnpm --filter='!@cherrio/contracts' lint`, `typecheck`, `pnpm --filter web check:design`: no errors. (First lint run: 2 errors — I had written a disable comment for an ESLint rule this project does not have; removed.)
- **E2E, whole suite:** `102 passed (1.9m)` — 94 earlier tests plus 8 new (4 × two viewports): logged-out redirects (2); without a verified organisation nothing can be started; create a draft → refused submit without cover → upload a JPEG → the image is shown from `http://127.0.0.1:9090/cherrio-public-local/campaigns/<id>/<24 hex>.webp` and readable without credentials → submit → read-only view "Our team is checking your campaign" → list shows it as "Waiting for review". axe: no violations on the empty list, the filled new form, the draft with cover, the in-review view and the list.
- YAML of `ci.yml`, `docker-compose.dev.yml`, `deploy.dev.yml` parses.

## NOT RUN
- docker build — not run locally (rule since TASK-028); CI "Image build" builds both images. That `sharp` loads in the Alpine image is therefore **unproven** until that job runs.
- GitHub Actions — NOT RUN until pushed.
- Hetzner public bucket — NOT RUN: public read, the base URL and the object ACL are first seen on dev (steps 5–6).
- The second deliberate break of the task (the `floor` in the USDC math) belongs to 010b.
- Indexer and contract tests — untouched.

## Open questions / risks
- **Size** (above).
- **`S3_PUBLIC_BASE_URL` is written from the naming scheme, not verified.**
- **A cover is public from the moment it is uploaded**, also for a draft that is never submitted (accepted). The form warns about photos of people.
- **No sweep for the public bucket** (accepted; open item in technical 09). A failed delete on replace, or an upload whose row insert failed, leaves a public orphan.
- **Memory:** sharp decodes up to 40 megapixels (about 160 MB uncompressed in the worst case) in a 384 MB container; concurrency is 1 and uploads are limited to 2 at a time, but one very large photo is the heaviest request the app has.
- **`requireOrgAdmin` answers 404 for a non-member and 409 for a not-yet-approved organisation** — the 409 tells a member that the organisation exists, which they know anyway.
- **Any `ORG_ADMIN` may edit a colleague's draft** (decided); there is no edit history.
- **`chain.campaign` column names** are still needed from dev before 010c.

## Suggested commit message
feat(web): campaign drafts, cover image upload and organisation campaign pages (TASK-010a)
