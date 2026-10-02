# TASK-008a-2 feedback — private files: routes, sweep, deploy config, storage check
Status: PARTIAL — everything in scope is implemented and proven locally; one decision is open (the diff is over the ~800-line rule, see "Size and split proposal"). GitHub Actions, Kamal and the real Hetzner bucket are NOT RUN.

## Steps for David

Before the merge to `dev` (already done according to the task message — listed so the order is on record):
1. Hetzner bucket `cherrio-private-dev` (private, `nbg1`) and its access key pair exist.
2. GitHub → Environments → `dev` → secrets `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `PRIVATE_FILES_KEY` exist. The key was generated once with `openssl rand -base64 32` and is stored in the password manager as `CHERR.IO – private files key dev`. **If this key is lost, every stored file is unreadable; there is no backup of the bucket yet. Never change it once files exist.**
3. `.kamal/secrets-common` has the three lines. I did not read or touch that file.

After the merge:
4. Watch the "Deploy" run on `dev`. New last step before the release tag: **Check private file storage**. Expected log line: `files:check ok — bucket reachable, probe written/read/deleted, canary created` (later deploys: `canary verified`).
5. If that step is red, the site is still up (it runs after the switch). The log names the cause without values: a missing variable, an S3 error name (credentials, bucket, endpoint), or `PRIVATE_FILES_KEY does not match…`.
6. Tell me the result; the second pass turns the labels from **Built** to **Live on dev**.
7. From then on, weekly on the server until the worker exists: `docker exec <web container> node apps/web/dist/files.mjs sweep --dry-run`, then `… sweep` (technical 08 §5.1, CHEATSHEET §6.1).

No step is needed for uat or prod: the check skips destinations without `S3_BUCKET`.

## What I implemented
- **A3 routes**
  - `POST /api/files/kyb` — origin check → session (401) → 30/min per user (429) → `Content-Length` required (411) and at most 10 MB + 64 KB (413), before the body is read → at most 2 uploads at a time per instance (503, `Retry-After: 5`) → multipart `file` + `kind` → real file size ≤ 10 MB checked again → magic bytes, SHA-256, encryption, store → in one transaction with a per-user advisory lock: at most 10 unattached files (409, the object is removed again), insert. Returns 201 `{ id, kind, sizeBytes }`.
  - `DELETE /api/files/kyb/:id` — uploader only (404 otherwise), unattached only (409). The row gets `deleted_at` first; the object is deleted after that; a failed object delete is logged (error name only) and left for the sweep.
  - `GET /api/admin/files/:id` — `PLATFORM_ADMIN` re-read from the DB; 404 with an empty body for everyone else. `audit_log` row (`private_file.download`, `private_file`, file id, `data: { kind }`, IP) is written before the response. Headers as specified; file name `<kind>-<last 8 of id>.<ext>`.
  - Error responses carry only a code; the texts are `files.errors.*` in `en.json`, and a test checks the two lists are equal.
- **A4** `files:sweep [--dry-run]` — unattached files older than 24 h (row marked first, only rows still unattached are returned and deleted); objects under `kyb/` without a live row (no row, or `deleted_at` set), only if older than 1 h. Never touches `check/`. Prints counts only; exit 1 if an object delete failed. An unknown flag (e.g. `--dryrun`) is refused instead of starting a real run.
- **A8** `files:check` — HeadBucket; probe object under `check/` written, read back, deleted in a `finally`; canary: created if absent, otherwise it must decrypt with `PRIVATE_FILES_KEY`.
- **A6** — `config/deploy.dev.yml` (three literals in `env.clear`, three names in `env.secret`); `deploy.yml` (three secrets in the deploy step, new check step after the smoke tests, gated on `S3_BUCKET` in the destination file).
- **Image** — one esbuild bundle `apps/web/dist/files.mjs` for both commands.
- **CI** — service `s3mock` in the `typescript` job.

## Files changed
- `apps/web/src/app/api/files/kyb/route.ts`, `…/kyb/[id]/route.ts`, `apps/web/src/app/api/admin/files/[id]/route.ts` (new) — routes
- `apps/web/src/lib/files/errors.ts`, `upload-slots.ts`, `sweep.ts`, `check.ts` (new); `storage.ts` (`defaultDeps` exported, `isUuid`, `removeStoredObject`)
- `apps/web/src/lib/security/rate-limit.ts` — `filesRateLimiter`, `FILES_RATE_LIMIT`
- `apps/web/scripts/files.ts` (new), `apps/web/package.json` (two scripts)
- `apps/web/messages/en.json` — `files.errors.*`
- `apps/web/next.config.mjs` — `experimental.middlewareClientMaxBodySize: "11mb"`
- `apps/web/src/__tests__/files-integration.test.ts` (new)
- `Dockerfile`, `config/deploy.dev.yml`, `.github/workflows/deploy.yml`, `.github/workflows/ci.yml`
- `packages/db/src/grant-admin.ts` — see deviations
- `docs/technical/04`, `05`, `06`, `07`, `08`, `09`, `docs/CHEATSHEET.md`

### `docs/technical/` chapters updated
- **04** — §5.8 (upload limits), §7 (three routes, error codes, body-limit setting). **05** — §4.1 env rows, new §4.3 "Private file storage" (old §4.3 is now §4.4). **06** — key custody row, storage row, new row "Private file access". **07** — CI service, deploy step 7, test strategy, web test count. **08** — §3, new §5.1 (check and sweep, weekly step). **09** — TASK-008 row. **CHEATSHEET** — §6 secrets row, new §6.1, §8.
- Everything new is labelled **Built**. All chapters already carried today's date (2026-10-02).

## Size and split proposal
Changed lines without docs and lockfile: **877** (109 in tracked files, 768 in new files; the test file alone is 333). That is over the ~800 rule, so I stop here and do not decide it myself.

- **Option 1 — split as agreed:** move to 008a-3: `lib/files/check.ts` (48), the check step in `deploy.yml` (25), the `check` branch of the CLI and `files:check` script (≈8), the check test (≈12). 008a-2 would then be ≈785 lines. Consequence: the first dev deploy would carry the new secrets without the check that proves them; the first real proof would be an upload, and no page uploads until 008b.
- **Option 2 — keep one PR at 877.** Production code is 544 lines; the rest is the test file.

The docs describe the state with the check included; with option 1 I remove those paragraphs from 05/07/08/CHEATSHEET in this PR.

## Deviations from the task (and why)
- **Body limit: raised in the Next config, not removed from the middleware matcher** (as instructed). Measured first: with the default, a real upload of exactly 10 MB returned 400 and the server logged `Request body exceeded 10MB for /api/files/kyb. Only the first 10MB will be available`. With `middlewareClientMaxBodySize: "11mb"` it returns 201. The route still enforces the real limits. It is an `experimental` key in Next 15.5 (the build prints it under "Experiments").
- **Canary key is `check/canary-v1`, not `check/canary`.** The key version cannot be recorded inside the canary (it is only readable with the right key) and `private_files` cannot hold it (the row needs an uploader and a KYB kind), so the version is in the object name. A future key version 2 gets its own canary and does not fail against the old one.
- **`packages/db/src/grant-admin.ts` changed (3 lines), not in the plan.** Its "run as main" test compared `process.argv[1]` with `import.meta.url`; inside any other bundle that imports `@cherrio/db` this is true, so `files.mjs` would have run grant-admin's CLI and exited. It now decides by file name only. Proven in the image: `node packages/db/dist/grant-admin.mjs` still prints its usage, and `files.mjs` runs its own commands.
- **Sweep and route tests are one test file.** The sweep looks at the whole bucket; in two files Vitest would run them in parallel and the sweep could delete another test's object.
- **Probe delete is a plain `finally`:** if both the probe write and the delete fail, the delete error is the one reported.
- **`pnpm install --frozen-lockfile`** was needed locally (the S3 SDK from 008a-1 was missing in `node_modules`), and I ran `pnpm --filter @cherrio/db migrate` on the local Docker database (it had no `private_files` table). No file changed by either.
- I attempted `git add -N` / `git reset` to count lines; the command was denied and did not run. Lines were counted with `git diff --numstat` and `wc -l`.

## New dependencies
- none. The bundle is built with the esbuild already in `@cherrio/db`.

## How to verify
1. `docker compose -f docker-compose.dev.yml up -d` (Postgres, Redis, s3mock)
2. `export DATABASE_URL=postgres://cherrio:cherrio@127.0.0.1:5432/cherrio_dev`
3. `pnpm --filter web test` → 11 files, 75 passed
4. `pnpm --filter @cherrio/db test:integration` → 15 passed
5. `APP_ENV=local PRIVATE_FILES_KEY=<fake key from apps/web/.env.example> pnpm --filter web files:check` → `files:check ok …`
6. `docker build -t cherrio-web:local .`

## Test results (all from this session)
- `pnpm --filter web test`: `Test Files 11 passed (11)`, `Tests 75 passed (75)`; `files-integration` 10 tests.
- `pnpm --filter @cherrio/db test:integration`: `Tests 15 passed (15)`.
- `pnpm --filter='!@cherrio/contracts' lint` and `typecheck`: all projects `Done`, no errors.
- **Deliberate break 1** (encryption disabled in `putPrivateFile`): `Tests 2 failed | 8 passed (10)` — `upload: the object in the bucket is not the plaintext … → expected true to be false`, and the admin download failed with `unknown format version`.
- **Deliberate break 2** (`requireRole` replaced by `requireUser` in the download route): `Tests 1 failed | 9 passed (10)` — `download by the uploader, another user or nobody is 404 … → expected 200 to be 404`.
- Both restored: `Tests 10 passed (10)`.
- **s3mock missing** (endpoint pointed at a closed port): `Error: files integration tests need s3mock on 127.0.0.1:9090`, `Test Files 1 failed (1)`. Vitest prints the 10 tests as "skipped" because `beforeAll` threw; the file and the run fail.
- **Real upload against `next start`** (curl, after the config change): exactly 10 MB → `201 … "sizeBytes":10485760`; 10 MB + 1 byte → `413 file_too_large`; chunked without `Content-Length` → `411 length_required`; anonymous → `401`; admin download → `200`, `content-disposition: attachment; filename="kyb_statute-3e9cc03f.pdf"`, `cache-control: no-store`, `x-content-type-options: nosniff`, `content-length: 10485760`, `cmp` identical to the upload; anonymous download → `404`; delete → `204`.
- **CLI locally:** `files:check ok — bucket reachable, probe written/read/deleted, canary verified`; `files:sweep (dry run — nothing deleted): 0 … 0 … 0`; `sweep --dryrun` → usage, exit 1.
- **`docker build -t cherrio-web:local .`**: `build rc=0`.
  - Image size: **262 MB** (`docker images`; 261,996,198 bytes). The previous image on this laptop, built 2026-10-01 14:23 UTC, shows **259 MB** (258,527,779 bytes) with the same command: **+3.5 MB**. I cannot reproduce the 369 MB written in the 008a-1 feedback; the like-for-like figures are the two above.
  - In the image: `apps/web/dist/files.mjs` 1.8 MB; 22 `@aws-sdk`/`@smithy`/`@aws-crypto` packages in the standalone `node_modules`, about 2.2 MB; both migrations present.
  - `node apps/web/dist/files.mjs check` in the image against s3mock: `files:check ok … canary verified`, rc 0. With `APP_ENV=dev` and no storage variables: `Missing storage configuration: S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY`, rc 1.
- YAML of `ci.yml`, `deploy.yml`, `deploy.dev.yml` parses; `deploy.dev.yml` has the 3 new clear and 3 new secret names.

## NOT RUN
- GitHub Actions (CI with the s3mock service, the deploy job) — NOT RUN until pushed.
- `kamal app exec … files.mjs check` — NOT RUN; no Kamal, server or secrets here.
- Hetzner Object Storage — NOT RUN; everything is proven against s3mock, which accepts any credentials.
- E2E (Playwright) — NOT RUN; no page changed.
- `pnpm --filter indexer test`, `forge test` — NOT RUN; untouched.
- A concurrent 10-file-limit race and the 503 under real parallel load — only tested through the handlers in one process.

## Open questions / risks
- **Split decision** (above).
- **`kamal app exec` environment:** the check step passes the same variables as the deploy step. I assume, as for migrations, that the container gets its secrets from the env file uploaded by `kamal deploy`; the first dev deploy proves it.
- **s3mock in CI has no health check;** the test waits up to 30 s for it. If the image ever starts slower, the web test step fails with the "need s3mock" message.
- **Build prints "Compiled with warnings"** (local and Docker); the build output does not show the warning text, so I cannot say whether it is new. The route table and the image are complete.
- **Memory:** two parallel 10 MB uploads hold about 60 MB in a 384 MB container. The download route has no such limit (admins only).
- **kamal-proxy `response_timeout: 30`** may end a slow 10 MB upload; first visible on dev.
- **Rate limit and upload slots are per container**, like the auth limiter.
- **`middlewareClientMaxBodySize` is experimental** and applies to every `/api/*` and page request (11 MB instead of 10 MB).
- **Local leftovers:** one orphan test object (random bytes) is in the local s3mock from the curl test; a sweep removes it after one hour, a container restart at once. The image `cherrio-web:local` was rebuilt; the previous one is now untagged.
- `eraseUser` still does not handle `private_files` (008c). From this PR on, files can exist on dev once a page or a direct API call uploads them.

## Suggested commit message
feat(files): upload, delete and audited admin download routes, sweep and deploy storage check (TASK-008a-2)
