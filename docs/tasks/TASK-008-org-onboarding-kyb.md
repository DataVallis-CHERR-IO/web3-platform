# TASK-008 — Organisation onboarding, manual KYB review, private file storage

Branches (David creates them from `dev`): `feat/TASK-008a-private-files`, `feat/TASK-008b-org-onboarding`, `feat/TASK-008c-kyb-admin`. Three PRs, in this order, each one reviewed before the next starts.
Depends on: TASK-025 (auth, roles), TASK-005 (schema), TASK-007 (design system). Model: strong (personal data, file handling, admin rights).

## Goal

A registered charity can apply to raise money on CHERR.IO, and a platform admin can verify it by hand (ADR-012). At the end of this task:

1. A logged-in user can register an organisation, or claim one that was imported from a public registry, and upload its verification documents.
2. The documents are stored encrypted in private object storage. Nobody but a platform admin can download them, and every download is logged.
3. A platform admin reviews pending applications in the admin area and approves or rejects them with a note.
4. The applicant sees the status of the application on their account.

Campaign creation (TASK-010), individual KYC (TASK-009), email notifications (worker) and the full admin panel (TASK-021) are **not** part of this task.

## Read first

- `CLAUDE.md`, `docs/00-MANIFEST.md`, `docs/03-DECISIONS.md` (ADR-012, ADR-014, ADR-022, ADR-024, ADR-028 and the new ADR-033/034 below)
- `docs/01-PRODUCT-SPEC.md` §1, §2.1, §4.1 (claiming imported organisations)
- `docs/02-ARCHITECTURE.md` §3, §4.4, §4.5
- `docs/technical/03-data-and-indexer.md` §2 (schema `app`, GDPR erase), `04-web-app-and-auth.md`, `06-security.md`
- `packages/db/src/schema/organizations.ts`, `enums.ts`, `audit.ts`, `packages/db/src/gdpr.ts`
- `apps/web/src/lib/auth/session.ts` (`requireUser`, `requireRole`), `apps/web/src/lib/security/*`
- `packages/ui/design-system/README.md` and `docs/design/README.md`
- `docs/tasks/TASK-025-auth.md` and its feedback (patterns for tests, E2E sessions and the admin guard)

## Decisions (CTO) — add to `docs/03-DECISIONS.md` in PR A

Insert after ADR-032, before ADR-019. Copy the text as given.

| ID | Date | Status | Decision | Reason |
|---|---|---|---|---|
| ADR-033 | 2026-10-02 | Accepted | **Private files go through the web app, encrypted by the app.** Uploads and downloads of private files (KYB documents now; evidence, invoices and medical documents later) pass through authenticated route handlers, not presigned URLs. The app encrypts every file with **AES-256-GCM** (random 96-bit IV per file, auth tag stored) using a per-environment key `PRIVATE_FILES_KEY` before it reaches **Hetzner Object Storage** (one private bucket per environment, S3 API). Object keys contain no personal data (`kyb/<orgId>/<fileId>`); original file names are not stored, only a document type. Every admin download is written to `audit_log`. Supersedes "presigned upload … with SSE" in ARCHITECTURE §4.5 for private files. | Encryption does not depend on the storage provider's features; the server can check file type and size and compute SHA-256 before storing; each access by staff is audited; no bucket CORS is needed. Files are small (≤ 10 MB), so passing them through the app is affordable. |
| ADR-034 | 2026-10-02 | Accepted | **KYB document retention:** documents of a **rejected** application are deleted when the applicant erases their account, and otherwise **90 days after the rejection**, even if the applicant keeps the account (a later resubmission brings new files). Files uploaded but never submitted are deleted after 24 hours. Documents of an **approved** application are kept while the organisation is active on CHERR.IO, as proof of verification, and deleted when the organisation is removed. Confirmed by David 2026-10-02. | Verified charities must stay verifiable; documents that no longer serve a purpose must not be kept (GDPR storage limitation). |

## Setup by David (before PR A can be proven against real storage)

The implementer never sees these values. Write this list into the PR A feedback as "Steps for David", with `PRIVATE_FILES_KEY` generation and the backup warning.

1. Hetzner Console → Object Storage → create bucket `cherrio-private-dev` (private, same location as the server). Create an access key pair for it.
2. Generate the file key once: `openssl rand -base64 32`. Store it in the password manager as `CHERR.IO – private files key dev`. **If this key is lost, every stored file becomes unreadable.**
3. GitHub → Environments → `dev` → secrets: `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `PRIVATE_FILES_KEY`. Variables: `S3_ENDPOINT` (e.g. `https://fsn1.your-objectstorage.com`), `S3_REGION`, `S3_BUCKET=cherrio-private-dev`.
4. `.kamal/secrets-common`: add `S3_ACCESS_KEY_ID=$S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY=$S3_SECRET_ACCESS_KEY`, `PRIVATE_FILES_KEY=$PRIVATE_FILES_KEY`.

## PR A — Private file storage (`feat/TASK-008a-private-files`)

### A1. Schema (Drizzle migration, backward compatible)

New enum `private_file_kind`: `KYB_REGISTRATION_EXTRACT`, `KYB_STATUTE`, `KYB_AUTHORISATION`, `KYB_OTHER`.

New table `app.private_files`:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `storage_key` | text unique not null | `kyb/<orgId or "unassigned">/<id>` — no names, emails or file names |
| `kind` | `private_file_kind` not null | |
| `mime_type` | text not null | from the magic-byte check, not from the browser |
| `size_bytes` | integer not null | plaintext size |
| `sha256` | char(64) not null | of the plaintext |
| `key_version` | smallint not null default 1 | for future key rotation |
| `uploaded_by` | uuid not null → users | |
| `kyb_submission_id` | uuid null → kyb_submissions | null until the application is submitted |
| `deleted_at` | timestamptz null | set when the object is deleted |
| `created_at` | timestamptz not null default now() | |

Indexes on `uploaded_by` and `kyb_submission_id`. Leave `kyb_submissions.private_file_keys` in place and unused (a later contract migration may drop it); note this in the feedback.

### A2. Storage module (`apps/web/src/lib/files/`)

- S3 client (`@aws-sdk/client-s3`, new dependency — justify in the plan) configured at **runtime** from `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. Missing config in dev/uat/prod is an error at first use, not at build time; `local` uses MinIO (A5).
- `encrypt` / `decrypt`: AES-256-GCM with Node `crypto`; key from `PRIVATE_FILES_KEY` (base64, must decode to exactly 32 bytes, else throw). Stored object format: `[1 byte format version][12 byte IV][ciphertext][16 byte tag]`. Decryption failure (wrong key, tampered object) throws and is never returned as a file.
- `putPrivateFile`, `getPrivateFile`, `deletePrivateFile`.
- File checks on upload: allowed types by **magic bytes** — PDF, JPEG, PNG only; max **10 MB** each; reject anything else with a clear error. Never trust the browser's `Content-Type` or file name.
- Logs: never log file contents, keys, presigned URLs or the full object key together with a user's email.

### A3. Upload and download routes

- `POST /api/files/kyb` (logged-in user; origin check and rate limit from `lib/security`; multipart, one file + `kind`): checks, SHA-256, encrypt, store, insert `private_files` with `kyb_submission_id = null`. Returns `{ id, kind, sizeBytes }`. A user may hold at most **10 unattached** files.
- `DELETE /api/files/kyb/:id`: only the uploader, only while unattached.
- `GET /api/admin/files/:id`: `PLATFORM_ADMIN` only (roles re-read from the DB, ADR-028); anyone else gets **404**. Streams the decrypted file with `Content-Disposition: attachment; filename="<kind>-<short id>.<ext>"`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. Writes `audit_log` (`action = "private_file.download"`, `entity_type = "private_file"`, `entity_id`).
- All user-facing messages through next-intl.

### A4. Housekeeping script

`pnpm --filter web files:sweep [--dry-run]`, bundled into the image like `grant-admin`: deletes unattached files older than 24 h and storage objects that have no `private_files` row (only under the `kyb/` prefix). Prints counts only. Run manually for now; scheduling is for the worker later.

### A5. Local development

Add a **MinIO** service to `docker-compose.dev.yml` (bound to `127.0.0.1` only, a fixed local bucket created on start) and document the local `S3_*` / `PRIVATE_FILES_KEY` values in `apps/web/.env.example` (placeholders only, a clearly fake local key). Tests use MinIO; a missing MinIO must fail the suite, not skip it.

### A6. Deploy config

Add the new secret and variable **names** to `config/deploy.yml` / `config/deploy.dev.yml` and to the web job's env in `.github/workflows/deploy.yml`. Do not touch `.kamal/secrets*` (David, setup step 4).

### A7. Tests (must be able to fail)

- Unit: encrypt/decrypt round trip; a flipped byte in IV, ciphertext or tag fails; wrong key fails; a key that is not 32 bytes is refused; magic-byte check accepts PDF/JPEG/PNG and refuses e.g. an HTML file renamed to `.pdf`; size limit; storage key contains no input from the user.
- Integration (Postgres + MinIO): upload → object in MinIO is **not** the plaintext (assert the plaintext's first bytes are absent) → admin download returns the original bytes and an `audit_log` row; non-admin download → 404; delete of an attached file is refused; sweep `--dry-run` lists and deletes nothing, real run deletes only what it listed.
- Deliberate break: disable encryption once, show the "not plaintext" test failing, restore.

## PR B — Organisation onboarding (`feat/TASK-008b-org-onboarding`)

### B1. Pages (logged in; human layer of ADR-022; design-system components only; all text via next-intl)

- `/en/organizations/new` — application form:
  - organisation name, legal name, country (ISO 3166-1 alpha-2 select), registry (`SI_AJPES`, `SI_MJU`, `UK_CC`, `US_IRS`, `NONE`), registry number (required unless `NONE`), website, short description (max 1,000 characters), causes (multi-select from a fixed list in `packages/shared`, reuse the emergency sub-pool themes where they fit), payout address;
  - documents: registration extract (required), statute (optional), proof that the applicant may represent the organisation (required), other (optional, up to 2). Upload happens per file (PR A route) with a progress state; the form submits the file ids.
  - A visible note: "Upload organisation documents only. Do not upload personal ID documents."
- `/en/account/organization` — the applicant's organisation(s) with status: `PENDING` (submitted, waiting), `APPROVED`, `REJECTED` (with the reviewer's note and a "Submit again" action). Link to it from the account page.

### B2. Validation (server side, zod schemas in `packages/shared`)

- Payout address: valid EVM address (checksum accepted), stored **lowercase** (DB check constraint). Show a warning that payouts can only go to this address and changing it later needs a new review.
- Registry number trimmed, max 64 characters; website `https://` only.
- One **pending** application per user at a time.

### B3. Submit (`POST /api/organizations` — one DB transaction)

1. Look up `(registry, registry_id)` when registry ≠ `NONE`:
   - no row → create `organizations` (`source = REGISTERED`, `kyb_status = PENDING`);
   - an `IMPORTED` row with `claimed_by_user_id` null → this is a **claim**: attach the application to that row, set `kyb_status = PENDING`, update name/description/website/causes/payout address from the form (keep `source = IMPORTED` until approval);
   - a `REGISTERED` row, or an imported row already claimed → refuse with "This organisation is already on CHERR.IO. Contact us if you represent it." (no detail about who claimed it).
2. Insert `org_members` (`ORG_ADMIN`) for the applicant if not already a member.
3. Insert `kyb_submissions` (`PENDING`, `submitted_by`).
4. Attach the uploaded files: set `kyb_submission_id` on the given `private_files` rows — only files uploaded by this user, unattached, and with the required kinds present; otherwise refuse the whole submit. Move nothing in storage (keys stay as created).
5. `audit_log`: `organization.apply` or `organization.claim`.

Resubmission after `REJECTED`: a new `kyb_submissions` row with new files for the same organisation; `kyb_status` back to `PENDING`.

### B4. Tests

- Integration: new org → rows in all four tables; claim of an unclaimed imported org (use the seed's imported orgs) → same row, `kyb_status = PENDING`, `source` still `IMPORTED`; claim of a registered/claimed org → refused, nothing written; second pending application → refused; foreign or already attached file ids → whole submit refused; resubmission after rejection.
- E2E (Playwright, existing session helper): fill the form, upload a small PDF and PNG, submit, see `PENDING` on `/en/account/organization`; axe check on both pages.

## PR C — KYB review in the admin area (`feat/TASK-008c-kyb-admin`)

### C1. Pages (`PLATFORM_ADMIN` only; everyone else 404, as `/en/admin` today)

- `/en/admin/kyb` — pending applications, oldest first: organisation, country, registry + number, submitted at, claim or new.
- `/en/admin/kyb/[submissionId]` — all submitted data, the applicant's display name and email, the list of documents (kind, size, SHA-256 short form, download link to `GET /api/admin/files/:id`), previous submissions for the same organisation with their notes, and two actions:
  - **Approve** → submission `APPROVED`, `reviewer_id`, organisation `kyb_status = APPROVED`; for a claim also `source = REGISTERED` and `claimed_by_user_id = submitted_by`.
  - **Reject** (note required, 10–1,000 characters, shown to the applicant) → submission `REJECTED`, organisation `kyb_status = REJECTED` (unless an earlier submission of the same organisation was approved — then keep `APPROVED` and only reject this submission).
- An admin cannot review their own application (refuse in the server handler, not only in the UI).
- Both actions run in one transaction and write `audit_log` (`kyb.approve` / `kyb.reject`, with the submission id; the note itself is not copied into the log).

### C2. GDPR and retention (`packages/db/src/gdpr.ts`, `files:sweep`) — per ADR-034

`eraseUser` additionally:
- deletes the user's **unattached** files and the files of their **non-approved** submissions: set `deleted_at` in the transaction, delete the storage objects **after** commit; a failed object delete is logged (no personal data) and left for `files:sweep`;
- keeps files of approved submissions (they belong to the organisation's verification);
- keeps `kyb_submissions.review_note`: review notes describe the organisation, not the person.

`files:sweep` (from PR A) gets a third rule: delete files of submissions with `status = REJECTED` whose rejection (`updated_at` of the submission) is older than **90 days**. It prints counts only, supports `--dry-run`, and is idempotent. Until the worker exists, David runs it manually (add it to the operator guide, technical 08, as a weekly step); scheduling it is a worker task later.

Update the doc comment of `eraseUser` accordingly and extend its integration test.

### C3. Tests

- Integration: approve new org; approve claim (source and claimant change); reject with note, then resubmit and approve; self-review refused; non-admin gets 404 on page and on the approve/reject handlers; audit rows present; `eraseUser` deletes the right files and keeps approved ones (MinIO objects checked); `files:sweep` deletes files of a submission rejected 91 days ago and keeps one rejected 89 days ago and every approved one (set `updated_at` in the test, do not sleep).
- E2E: admin opens the queue, downloads a document (status 200, `content-disposition: attachment`), rejects with a note; applicant sees the note; resubmits; admin approves; applicant sees `APPROVED`.

## Docs (definition of done, per `docs/technical/README.md`)

- PR A: ADR-033/034; `docs/02-ARCHITECTURE.md` §4.5 (pointer to ADR-033); technical 03 (`private_files`), 05 (Object Storage bucket per env; MinIO locally), 06 (file encryption, key custody, audit of downloads; open item: no backup of the bucket yet — Planned before mainnet), 08 (`files:sweep`); CHEATSHEET (bucket, secret names, key in the password manager — never values).
- PR B: technical 01 (actors: organisation onboarding Live on dev after deploy), 04 (routes), 09.
- PR C: technical 04 (admin routes), 06 (self-review rule), 08 (how to review an application), 09.
- Status labels: write **Built** until David confirms the deploy on dev; the second pass of each PR (or the next PR) turns them into **Live on dev**.

## Must not touch

- Contracts, indexer, `infra/`, `.kamal/secrets*`, `.env*` (except `.env.example` placeholders), the Privy/session code beyond reusing it.
- No personal data in object keys, logs, `audit_log.data` or test fixtures committed to the repo (use generated dummy PDFs/PNGs).
- No presigned URLs for private files (ADR-033).
- No new dependencies besides `@aws-sdk/client-s3` without justification in the plan.

## Acceptance (per PR; all must hold before the next PR starts)

- [ ] Plan approved before code; deviations listed in the feedback.
- [ ] Migration applies on a copy of the current schema and is backward compatible with the deployed code.
- [ ] Tests listed for the PR exist, pass, and the deliberate-break step was shown.
- [ ] `pnpm --filter='!@cherrio/contracts' lint` and `typecheck` clean; `pnpm --filter web test`, `pnpm --filter @cherrio/db test:integration`, E2E for the touched pages green; `docker build` of the web image succeeds (new dependency, new script).
- [ ] `grep` of the diff: no secret values, no server IP, no real personal data.
- [ ] Docs updated as listed; feedback names the chapters.
- [ ] Each PR ≤ ~800 changed lines excluding lockfile and docs; if it grows beyond that, stop and propose a split.

## Suggested commit messages

- `feat(files): encrypted private file storage on Hetzner Object Storage (TASK-008a)`
- `feat(web): organisation application and claim flow (TASK-008b)`
- `feat(admin): KYB review queue with approve/reject and audited downloads (TASK-008c)`
