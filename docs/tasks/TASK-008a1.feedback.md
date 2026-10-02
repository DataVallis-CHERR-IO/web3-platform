# TASK-008a-1 feedback — private files: schema and storage core
Status: DONE

First of the two PRs that PR A of TASK-008 was split into (CTO decision). This PR adds no route, no deploy configuration and no user-visible behaviour: nothing can be uploaded yet. Routes, sweep, deploy config, the storage check and the integration tests are TASK-008a-2.

## What I implemented
- **ADR-033 and ADR-034** in `docs/03-DECISIONS.md`, after ADR-032, text copied from the task file (checked by script; no existing row changed; ADR-019 still last).
- **A1 schema:** enum `private_file_kind`, table `app.private_files`, migration `0001_goofy_agent_zero.sql`.
- **A2 storage module** in `apps/web/src/lib/files/`:
  - `config.ts` — S3 settings and `PRIVATE_FILES_KEY`, read at first use. `APP_ENV` must be set (`parseAppEnv` from `@cherrio/shared`); a missing `APP_ENV` throws `[Files] APP_ENV is not set`. Only an explicit `APP_ENV=local` falls back to the local s3mock for unset S3 variables; in dev/uat/prod a missing variable throws and names the variable, never a value. The key must be clean base64 of exactly 32 bytes.
  - `crypto.ts` — AES-256-GCM, object `[1 byte version = 1][12 byte IV][ciphertext][16 byte tag]`, fresh random IV per file, storage key as additional authenticated data. Any failure throws `PrivateFileDecryptError`; no unverified bytes are returned.
  - `file-type.ts` — PDF, JPEG, PNG by magic bytes at offset 0; 10 MB limit; `FileRejectedError` with a code.
  - `s3.ts` — `@aws-sdk/client-s3` behind a five-method `ObjectStore` interface (put, get, delete, list, check); path-style addressing, checksums `WHEN_REQUIRED`.
  - `storage.ts` — `kybStorageKey`, `putPrivateFile`, `getPrivateFile`, `deletePrivateFile`.
- **A5 (part):** service `s3mock` (`adobe/s3mock:5.2.3`) in `docker-compose.dev.yml`, bound to `127.0.0.1:9090`, bucket `cherrio-private-local`; `apps/web/.env.example` with local values and a clearly fake key.
- **Unit tests** (23) and one DB integration test for the table.

## Migration
```sql
CREATE TYPE "app"."private_file_kind" AS ENUM('KYB_REGISTRATION_EXTRACT', 'KYB_STATUTE', 'KYB_AUTHORISATION', 'KYB_OTHER');
CREATE TABLE "app"."private_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"storage_key" text NOT NULL,
	"kind" "app"."private_file_kind" NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" char(64) NOT NULL,
	"key_version" smallint DEFAULT 1 NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"kyb_submission_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "private_files_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "private_files_size_bytes_check" CHECK (… "size_bytes" > 0 AND … "size_bytes" <= 10485760),
	CONSTRAINT "private_files_sha256_format" CHECK (… "sha256" ~ '^[0-9a-f]{64}$')
);
-- plus two foreign keys (uploaded_by → users, kyb_submission_id → kyb_submissions) and two indexes
```
Backward compatible: it only adds a type and a table. The deployed code does not know the table, and the new foreign key to `users` cannot block the deployed `eraseUser`, which anonymises the user row and never deletes it. `kyb_submissions.private_file_keys` is left in place and unused; a later migration may drop it.

## Files changed
- `docs/03-DECISIONS.md` — ADR-033, ADR-034
- `packages/db/src/schema/files.ts` (new), `enums.ts`, `index.ts`, `helpers.ts` (`newId()`)
- `packages/db/drizzle/0001_goofy_agent_zero.sql`, `meta/0001_snapshot.json`, `meta/_journal.json` (generated)
- `packages/db/src/__tests__/integration.test.ts` — 19 tables, `private_files` constraints
- `apps/web/src/lib/files/config.ts`, `crypto.ts`, `file-type.ts`, `s3.ts`, `storage.ts` (new)
- `apps/web/src/__tests__/files-crypto.test.ts`, `files-type.test.ts`, `files-storage.test.ts` (new)
- `apps/web/package.json`, `pnpm-lock.yaml` — `@aws-sdk/client-s3`
- `docker-compose.dev.yml` — `s3mock`
- `apps/web/.env.example` (new)
- `docs/02-ARCHITECTURE.md` §4.5, `docs/technical/03`, `06`, `09`

### `docs/technical/` chapters updated
- **03** — §2 (19th table `private_files`, **Built**), §2.2 (second migration), §2.4 (files and `eraseUser`: Planned for 008c).
- **06** — §3 key custody (`PRIVATE_FILES_KEY`), §8 (private storage and retention rows), §11 (open items: no bucket backup, no key rotation procedure, no virus scan).
- **09** — TASK-008 row: In progress.
- All three dated 2026-10-02. Everything new is labelled **Built**, nothing as Live.

## Deviations from the task (and why)
- **PR A split in two** (CTO decision); this is the first half.
- **adobe/s3mock instead of MinIO** (CTO decision): MinIO images could not be pulled from Docker Hub or Quay.
- **Storage key as GCM additional data**, the two `CHECK` constraints (approved in the plan).
- **`newId()` exported from `@cherrio/db`:** the file id must be known before the insert, because the storage key is built from it and bound into the encryption.
- **`putPrivateFile` takes the storage key from the caller** (built with `kybStorageKey`), instead of creating ids itself.
- **`packages/db/src/__tests__/integration.test.ts`** was changed (not in the plan's file list): it asserts the exact table list, which is now 19; I added one test for the new table's constraints.
- **`docs/technical/09`** updated although the split assigned only 03 and 06 to this PR: the maintenance rule asks for the status table.
- **Storage tests use an in-memory object store.** The s3mock-backed integration tests and the CI change belong to 008a-2; a test that needs s3mock here would fail CI until then. The real S3 client was exercised once by hand against s3mock (output below).

## New dependencies
- `@aws-sdk/client-s3@^3.1145.0` (web) — S3 API client for Hetzner Object Storage: request signing, retries, paginated listing. 24 packages (`@aws-sdk/*`, `@smithy/*` and related) were added to the store. No route imports it yet, so the Next.js standalone output should not contain it until 008a-2; the image size effect is measured there.

## How to verify
1. `docker compose -f docker-compose.dev.yml up -d` (now also starts `s3mock` on `127.0.0.1:9090`).
2. `export DATABASE_URL=postgres://cherrio:cherrio@127.0.0.1:5432/cherrio_dev`
3. `pnpm --filter @cherrio/db test:integration` → 15 passed.
4. `pnpm --filter web test` → 64 passed (23 of them `files-*`).
5. `pnpm --filter='!@cherrio/contracts' lint` and `typecheck` → clean.

## Test results
- `pnpm --filter web test`: 10 files, 64 tests passed (`files-crypto` 12, `files-type` 4, `files-storage` 7).
- `pnpm --filter @cherrio/db test:integration`: 15 passed. This suite drops schema `app` and re-creates it from migrations `0000` + `0001`.
- **Migration on a copy of the current schema:** schema-only copy of the local database at migration `0000` (19 relations incl. the journal, 1 migration) → `migrate` → 2 migrations, `private_files` with 11 columns and 6 constraints; a second run is a no-op. On that copy the old integration suite gave `1 failed | 13 passed`: the one failure was its own assertion of exactly 18 tables, which I then updated.
- **Deliberate break** (encryption disabled in `putPrivateFile`): `2 failed | 5 passed (7)` — `what reaches the store is not the plaintext → expected true to be false`, and the round trip failed with `unknown format version`. Restored: 7 passed.
- **Real S3 client against s3mock** (one-off script, not in the repo): `HeadBucket ok`; stored 2073 plaintext bytes as a 2102-byte object; `raw object contains plaintext header: false`; `round trip equal: true`; listed under `kyb/`; after delete `null` and 0 objects.
- `pnpm --filter='!@cherrio/contracts' lint` and `typecheck`: 7 projects Done, 0 errors.
- `docker build -t cherrio-web …`: succeeded (`build rc=0`), image 369 MB. Inside the image: 0 `aws-sdk`/`smithy` packages (no route imports the SDK yet) and the new migration `packages/db/drizzle/0001_goofy_agent_zero.sql` is present.

## NOT RUN
- Hetzner Object Storage — NOT RUN; no bucket or credentials exist yet. Everything is proven against an in-memory store and the local s3mock only.
- E2E (Playwright) — NOT RUN; no page or route changed.
- `pnpm --filter indexer test`, `forge test` — NOT RUN; untouched.
- GitHub Actions — NOT RUN until pushed. CI needs no s3mock for this PR.

## Steps for David
None for this PR: it needs no secret and no bucket, and the migration runs with the normal web deploy.

The setup steps of the task (bucket, `PRIVATE_FILES_KEY`, GitHub secrets and variables, `.kamal/secrets-common`) are needed **before the 008a-2 merge**; they will be listed at the top of that feedback file. For reference, the key is generated once with `openssl rand -base64 32` and stored in the password manager as `CHERR.IO – private files key dev`. **If this key is lost, every stored file becomes unreadable**, and there is no backup of the bucket yet.

## Open questions / risks
- **A file's storage key must never change** after upload (it is part of the encryption). PR B must therefore keep `kyb/unassigned/<id>` when a file is attached, as the task already says.
- **s3mock accepts any credentials and keeps nothing after a restart**; wrong-credential and provider-specific behaviour is first seen on dev (item A8 in 008a-2).
- **Memory:** a file is held in memory two to three times during upload or download (up to about 30 MB for a 10 MB file).
- **No virus scan;** magic bytes prove only the header.
- **`eraseUser` does not handle `private_files` yet** (Planned for 008c). Until 008a-2 no file can exist, so nothing is left behind.
- **No key rotation procedure;** `key_version` is prepared only.
- `docs/technical/01` and `09` §1 still say 18 tables for what is live on dev, which stays true until this PR is deployed.

## Suggested commit message
feat(files): private_files schema and encrypted storage core (TASK-008a-1)

## Review round (CTO, 2026-10-02)

### 1. Fix: `getS3Config` no longer defaults `APP_ENV` to `local`
- New unit test `without APP_ENV it throws and never falls back to the local store` in `files-crypto.test.ts`.
- Against the old code: `× … → expected { …(5) } to be undefined`, `Tests  1 failed | 12 passed (13)` (the old code returned the local s3mock config).
- After the fix: `✓ src/__tests__/files-crypto.test.ts (13 tests)`, `Tests  13 passed (13)`.
- `pnpm --filter='!@cherrio/contracts' lint` and `typecheck` after the fix: 7 projects Done, 0 errors.

### 2. Web image build, before/after the new dependency — NOT RUN
- **Blocked:** when I came back to this, the Docker daemon on the laptop was no longer running (`Cannot connect to the Docker daemon at unix:///…/docker.sock`), and nothing listens on port 5432. I did not start it (CLAUDE.md: do not start services; environment broken → stop and report).
- **"After" build:** the only result I have is from before this fix, when Docker was still up: `build rc=0`, image 369 MB, 0 `aws-sdk`/`smithy` packages in the image, migration `0001` present. The fix changes no dependency, but that build is not of the final code. NOT RUN for the final code.
- **"Before" build** (the branch base `d52d839`, without the dependency): NOT RUN — Docker daemon not running. So there is no before/after comparison yet.
- **Full `pnpm --filter web test` after the fix:** `1 failed | 59 passed | 5 skipped (65)`. The failure (`GET /api/health … db ok`) and the 5 skipped `session-db` tests are the database-backed tests: `connect ECONNREFUSED 127.0.0.1:5432`. All 24 `files-*` tests passed in that run. The last full green run (64 passed) was before the fix, with the database up.

Status is PARTIAL until the two builds and one full green web test run exist. Commands, once Docker is up:
```bash
docker compose -f docker-compose.dev.yml up -d
export DATABASE_URL=postgres://cherrio:cherrio@127.0.0.1:5432/cherrio_dev
pnpm --filter web test                      # expected: 65 passed
docker build -t cherrio-web:after .         # then: docker images cherrio-web:after
```
The "before" image is built from the branch base in a scratch copy (`git archive d52d839`), which changes nothing in the repository.

### 3. Final run after Docker was restarted (David, 2026-10-02)
David decided to skip the "before" build. On the final code, with `docker compose -f docker-compose.dev.yml up -d` (Postgres, Redis and s3mock up):

- `pnpm --filter @cherrio/db test:integration`: `Test Files  1 passed (1)`, `Tests  15 passed (15)`.
- `pnpm --filter web test`: `Test Files  10 passed (10)`, `Tests  65 passed (65)` (`files-crypto` 13, `files-storage` 7, `files-type` 4; `session-db` 5 and `health` 5 green again).
- `docker build -t cherrio-web:local .`: `build rc=0`, `image size=369MB`. In the image: `sdk packages: 0` (no route imports the S3 SDK yet) and both migrations, `0000_perpetual_dust.sql` and `0001_goofy_agent_zero.sql`.

This closes the two open points of section 2 above: status DONE. There is no before/after size comparison in this PR; the image size is measured again in TASK-008a-2, where the S3 SDK enters the image through the routes (369 MB is the figure to compare against).

The image `cherrio-web:local` is left on the laptop, as named in the instruction.
