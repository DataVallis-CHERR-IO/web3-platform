# 03 — Data and indexer

CHERR.IO keeps two kinds of data in one Postgres 16 (+ pgvector) server. **Off-chain application data** (users, organisations, campaign drafts, ratings, points, audit log) lives in schema `app`, managed with Drizzle by the web app. **On-chain state** (campaigns, donations, votes, refunds, Emergency Pool balances and allocations) is copied from the smart contracts by the **Ponder indexer**, which writes it to a per-deploy schema `chain_<sha7>` and publishes stable read-only views in schema `chain`. The web app reads chain data only through those views and never writes chain state. Each environment (dev, uat, prod) has its own database, its own web role and its own indexer role. This page describes both halves, how they are deployed and how they are kept honest (reconcile).

Last updated: 2026-10-03

Status legend: **Live on dev** = running on https://dev.cherr.io · **Built (not deployed)** = code merged, not running on a server · **Planned** = described in docs, no code yet.

| Part | Status |
|---|---|
| `app` schema, migrations, seed, `eraseUser` | Live on dev |
| Ponder indexer (handlers, reconcile, prune, image, Kamal config, deploy job) | Live on dev since 2026-10-01 (TASK-026) |
| Indexer DB role `cherrio_indexer_<env>` and the new connection budget | Live on dev — applied on the server by David with `ensure-databases.sh` before the first indexer deploy (TASK-026); uat/prod roles not created yet |
| Web app reading `chain.*` views | Live on dev for campaign linking (TASK-010c); public campaign pages Live on dev (TASK-011a, PR #50) |
| Worker queues consuming indexed events (points, trust score, notify) | Planned |

---

## 1. Postgres layout

One Postgres 16 instance with the pgvector extension serves all three environments, with one database per environment: `cherrio_dev`, `cherrio_uat`, `cherrio_prod`. Inside each database (ADR-026):

| Schema | Written by | Owner | Read by | Content |
|---|---|---|---|---|
| `app` | web app (Drizzle migrations + route handlers) | web role `cherrio_<env>` | web app (and later the worker) | Off-chain application tables (§2) and the Drizzle journal `app.__drizzle_migrations` |
| `chain_<sha7>` | Ponder, one schema per deployed indexer commit | indexer role `cherrio_indexer_<env>` | nobody directly except Ponder, reconcile and prune | The 13 indexer tables (§4.4) plus Ponder's internal `_ponder_meta` / `_ponder_checkpoint` |
| `chain` | Ponder (`--views-schema chain`) | indexer role | web role (SELECT only), reconcile | Stable views pointing at the live `chain_<sha7>` |
| `ponder_sync` | Ponder | indexer role | Ponder only | RPC cache (blocks, logs, receipts), kept across deploys so a re-index is fast |

Why per-deploy schemas: Ponder refuses to reuse a schema written by different code, so a fixed `chain` schema would break on the second deploy. Each code-changing deploy re-indexes from `startBlock` into a new `chain_<sha7>`; the `chain` views switch to it when it is ready, so readers have a stable contract and zero-downtime switches (ADR-026).

Connections:

- Web app traffic goes through **PgBouncer** in transaction mode (`DATABASE_URL`). `createDb()` therefore uses `prepare: false`.
- Migrations, seed, `grant-admin` and GDPR erasure use a **direct** connection (`DATABASE_URL_DIRECT`) because they need session features (advisory locks, transactions).
- Ponder connects **directly** to Postgres and never through PgBouncer (it uses LISTEN/NOTIFY). `lib/env.ts` refuses a URL on port 6432 or with `pgbouncer` in the host name.

Sources: `docs/03-DECISIONS.md` (ADR-021, ADR-026), `docs/02-ARCHITECTURE.md` §5, `infra/README.md`, `packages/db/src/index.ts`, `packages/db/src/migrate.ts`, `apps/indexer/lib/env.ts`, `docs/CHEATSHEET.md` §3 and §10.

---

## 2. The `app` schema (Drizzle)

Status: **Live on dev** for 18 tables and 17 Postgres enums, all in schema `app`. A 19th table, `private_files`, with its enum `private_file_kind` is **Built** (TASK-008a-1, migration `0001`) and reaches dev with the next web deploy.

Conventions used by every table:

- Primary key `id` is a **UUID v7** generated in TypeScript (`uuidPk()`, package `uuid`), so ids sort by time. Postgres 16 has no native `uuidv7()`.
- USDC amounts are `numeric(78,0)` mapped to TypeScript `bigint` (`numeric78`), enough for the full `uint256` range. EUR amounts are integer cents. Never floats.
- Hashes and 32-byte ids are `bytea` (`Buffer` in TS).
- Ethereum addresses are `varchar(42)` with a CHECK `^0x[0-9a-f]{40}$` (lowercase).
- Most tables have `created_at` / `updated_at` (`timestamptz`); append-only tables have only `created_at`.

### 2.1 Tables

**Users and access**

| Table | Purpose | Key columns |
|---|---|---|
| `users` | One row per person who logged in | `display_name` (default pseudonym "Supporter XXXX"), `email` (nullable), `privy_did` (unique; null after erasure), `locale` (default `en`), `anonymous_donations`; **Built** (TASK-031): `display_currency` (nullable; the display currency the user chose, ADR-040, written back into the cookie at login) |
| `user_addresses` | Links a person to on-chain addresses — personal data | `user_id`, `address` (unique, lowercase), `kind` (`EMBEDDED` / `SMART_ACCOUNT` / `EXTERNAL`), `is_primary` |
| `user_roles` | Platform-level roles only | `user_id`, `role` (only `PLATFORM_ADMIN`); unique (`user_id`, `role`) |

**Organisations and verification**

| Table | Purpose | Key columns |
|---|---|---|
| `organizations` | Registered or imported charities (Charity Market Cap) | `source` (`REGISTERED` / `IMPORTED`), `name`, `legal_name`, `country`, `registry` (`SI_AJPES`, `SI_MJU`, `UK_CC`, `US_IRS`, `NONE`), `registry_id` (unique with `registry`), `causes[]`, `kyb_status`, `claimed_by_user_id`, `payout_address`, `logo_cid` |
| `org_members` | The only source of organisation membership | `org_id`, `user_id`, `role` (`ORG_ADMIN` / `ORG_MEMBER`); unique (`org_id`, `user_id`) |
| `kyb_submissions` | Manual KYB reviews of an organisation (ADR-012) | `org_id`, `submitted_by`, `status`, `reviewer_id`, `review_note`, `reviewed_at` (**Built**: set on approve and reject; the 90-day retention of rejected documents counts from here), `private_file_keys[]` (unused), `application` (jsonb, **Built**: the validated form data of that submission — name, legal name, country, website, description, causes, payout address; no file data, nothing about the applicant). Partial unique index (**Built**): at most one `PENDING` submission per `submitted_by` |
| `private_files` (**Built**) | One row per encrypted object in private storage (ADR-033); no file name, no personal data | `storage_key` (unique, `kyb/<orgId or "unassigned">/<id>`), `kind`, `mime_type` (from the server's magic-byte check), `size_bytes` (1 byte – 10 MB, checked), `sha256` of the plaintext (64 lowercase hex, checked), `key_version` (default 1), `uploaded_by` → users, `kyb_submission_id` → kyb_submissions (null until submitted), `deleted_at` |
| `kyc_checks` | Sumsub applicant status only — no document data (ADR-014) | `user_id`, `provider` (default `SUMSUB`), `applicant_id`, `status`, `level`, `reviewed_at` |

**Campaigns**

| Table | Purpose | Key columns |
|---|---|---|
| `campaigns` | Off-chain campaign record from draft to deployment | `offchain_id` (32 bytes, unique), `org_id`, `starter_user_id`, `beneficiary_type`, `beneficiary_address` (required once `APPROVED`/`DEPLOYED`), `title`, `slug` (unique), `story` (jsonb), `cause`, `country`, `target_eur_cents`, rate snapshot `eur_usd_rate` / `rate_source` / `rate_at`, `target_usdc`, `duration_days`, `status` (`DRAFT` → `PENDING_REVIEW` → `APPROVED` / `REJECTED` → `DEPLOYED`), `review_note`, `onchain_address` (unique; the clone address); **Live on dev** (TASK-010a): `submitted_at`, `reviewed_at`, `reviewer_id`, `publish_tx_hash` (0x + 64 hex, checked), `deadline`, `deployed_at`. `story` holds `{ "format": "plain", "text": … }` (plain text, rendered escaped); `target_eur_cents` is whole euros × 100; `offchain_id`, the rate fields, `target_usdc` and `beneficiary_address` stay empty until approval. **At approval** (**Live on dev**, TASK-010b): `eur_usd_rate` = the ECB USD rate with 8 decimals (e.g. `1.17340000`), `rate_source = 'ECB'`, `rate_at` = the ECB rate date (00:00 UTC), `target_usdc = floor(target_eur_cents × rate × 10⁴)` in micro-USDC, `beneficiary_address` = the organisation's verified `payout_address` (lowercase), `offchain_id` = 32 random bytes (kept if a campaign is ever approved again), `reviewer_id`, `reviewed_at`; `review_note` is cleared. A rejection sets `REJECTED`, `review_note`, `reviewer_id`, `reviewed_at` and leaves the snapshot empty. **Publishing** (**Live on dev**, TASK-010c): preparing the call sets `deadline` (whole seconds; again on every new attempt); the sent transaction sets `publish_tx_hash`; linking sets `status = DEPLOYED`, `onchain_address`, `deployed_at` (the block time) and overwrites `publish_tx_hash` with the hash the indexer saw |
| `fx_rates` | Display-only exchange rates (**Built**, TASK-031; ADR-040). Never used for money logic; not personal data | `currency` (PK, e.g. `CHF`, `BTC`), `usd_per_unit` (numeric(38,18): USD per one unit, 1 USDC = 1 USD), `source` (`ECB` / `COINGECKO`, checked), `rate_at` (ECB rate date, or CoinGecko's last-updated time), `fetched_at`. One row per currency, overwritten on each refresh (no history). Fiat: `USD per X = (USD per EUR) ÷ (X per EUR)` from the ECB daily file; EUR = USD per EUR. Refresh and staleness rules: `04-web-app-and-auth.md` §2a |
| `campaign_media` | Public images, video links and PDFs of a campaign | `campaign_id`, `kind` (`COVER` / `GALLERY` / `VIDEO` / `DOCUMENT`), `cid`, `storage` (`POLLINATIONX` / `PINATA` / `HETZNER_PUBLIC` — **Live on dev**, ADR-037; `cid` then holds the object key in the public bucket / `EXTERNAL`), `sort`; **Built** (TASK-030, ADR-039): `label` (PDF title shown on the page, from the file name), `size_bytes`, `created_by` (→ `users`, who added it). A video row has `storage = EXTERNAL` and `cid = youtube:<id>` or `vimeo:<id>` — only the video id is stored, nothing is downloaded. Limits per campaign (10 gallery images, 3 videos, 5 documents) are checked in the app under a per-campaign advisory lock (`pg_advisory_xact_lock`), not by a constraint |
| `evidence_bundles` | Milestone evidence per round | `campaign_id`, `round` (0–2; unique with campaign), `bundle_hash` (32 bytes, anchored on chain), `private_file_keys[]`, `public_cids[]`, `status` |

**Social, trust and points**

| Table | Purpose | Key columns |
|---|---|---|
| `ratings` | Off-chain EIP-712 signed ratings, one per (campaign, user) | `org_id`, `campaign_id`, `user_id`, `stars` (1–5), `comment`, `signature` |
| `points_ledger` | Append-only points journal | `user_id`, `bucket` (`STATUS` / `REWARD`), `delta` (bigint), `reason`, `ref_type` / `ref_id`, `rule_version`, `voided_at` / `voided_reason` |
| `user_levels` | One row per user; counters equal the sum of the ledger | `user_id` (PK), `level`, `status_points`, `reward_points`, `last_activity_at` |
| `trust_scores` | Append-only, versioned org scores; latest row per org is current (ADR-013) | `org_id`, `version`, `score` (0–100.00), `components` (jsonb), `computed_at` |
| `registry_records` | Raw registry import snapshots (SI, UK, US) | `registry`, `registry_id` (unique together), `raw` (jsonb), `fetched_at` |

**Emergency Pool, finance, audit**

| Table | Purpose | Key columns |
|---|---|---|
| `emergency_subpools` | Display metadata for Emergency Pool sub-pools | `pool_id` (matches the on-chain `uint32` pool id, ≥ 0), `slug`, `name_key` / `description_key` (next-intl keys, no hard-coded UI text) |
| `onramp_orders` | Transak card-onramp orders (ADR-004) | `user_id`, `provider` (`TRANSAK`), `provider_order_id` (unique), `status`, `fiat_amount_cents`, `fiat_currency`, `usdc_amount`, `wallet_address`, `campaign_id` (optional) |
| `audit_log` | Append-only audit trail | `actor_user_id` (null for system actions), `action` (e.g. `auth.login`, `wallets.synced`, `account.deleted`), `entity_type`, `entity_id`, `data` (jsonb), `ip` |

Only `users`, `user_addresses`, `user_roles` and `audit_log` are written by live code today (auth, TASK-025); `emergency_subpools` and `organizations` contain seed data; the other tables are schema only, waiting for their tasks.

### 2.2 Migrations

- Generated with drizzle-kit into `packages/db/drizzle/`; seven migrations exist: `0000_perpetual_dust.sql` (live on dev), `0001_goofy_agent_zero.sql` (**Live on dev**: adds only the enum `private_file_kind` and the table `private_files`) and `0002_cold_supreme_intelligence.sql` (**Live on dev**, TASK-008b-1: adds `kyb_submissions.application` with default `'{}'` and the partial unique index on pending submissions). `0003_concerned_bruce_banner.sql` (**Live on dev**, TASK-008c-1) adds the nullable `kyb_submissions.reviewed_at`. `0004_ambiguous_karen_page.sql` (**Live on dev**, TASK-010a) adds six nullable columns to `campaigns` and the enum value `HETZNER_PUBLIC`. `0006_polite_hobgoblin.sql` (**Built**, TASK-031) adds the table `fx_rates` and the nullable `users.display_currency`. `0005_nappy_dark_phoenix.sql` (**Live on dev**, TASK-030) adds the enum values `media_kind.DOCUMENT` and `storage_provider.EXTERNAL` and three nullable columns to `campaign_media` (`label`, `size_bytes`, `created_by` with a foreign key to `users`). The later ones only add, so they are backward compatible with the deployed code. It also runs `CREATE EXTENSION IF NOT EXISTS "vector"` (a no-op on the server, where `infra/shared/ensure-databases.sh` installs the extension as superuser) and `CREATE SCHEMA IF NOT EXISTS "app"`.
- Runner: `packages/db/src/migrate.ts`, journal in `app.__drizzle_migrations`, one connection, prefers `DATABASE_URL_DIRECT`.
- **In deploys** (`.github/workflows/deploy.yml`, job "Build → Deploy → Migrate"): the web image contains `packages/db/dist/migrate.mjs` (bundled by esbuild in the `Dockerfile`) plus the SQL files. After `kamal deploy` the job runs `kamal app exec --primary "node packages/db/dist/migrate.mjs"` against the new version, then the smoke tests on `/api/health`. Migrations run **after** the deploy because Kamal uploads the env files during boot; this is safe only because migrations must be backward compatible (expand → migrate → contract, Architecture §5.3).
- Locally: `pnpm --filter db migrate`.

### 2.3 Seed

`packages/db/src/seed.ts` (`pnpm --filter db seed`) is idempotent (`ON CONFLICT DO NOTHING`) and is **not** run by the deploy job. It inserts:

- 5 Emergency Pool sub-pools: `general` (0), `medical` (1), `disasters` (2), `animals` (3), `climate` (4).
- 3 imported sample organisations (UK Charity Commission, US IRS, Slovenian AJPES registry entries).
- `PLATFORM_ADMIN` for the user who owns `SEED_ADMIN_ADDRESS` — **only if that address has already logged in**. The seed never creates placeholder users or addresses (they would conflict with the real first login). Otherwise use the `grant-admin` CLI (see `04-web-app-and-auth.md`).

### 2.4 GDPR erasure (`eraseUser`)

`packages/db/src/gdpr.ts` → `eraseUser(db, userId)`, one transaction, called by `DELETE /api/auth/account` over the direct connection:

| What | Action |
|---|---|
| `users` | `display_name = 'Deleted user'`, `email = NULL`, `privy_did = NULL` (the row stays) |
| `user_addresses` | rows deleted (person ↔ address link is personal data, ADR-014) |
| `user_roles` | rows deleted (admin rights revoked immediately) |
| `org_members` | rows deleted |
| `kyc_checks` | rows deleted (Sumsub applicant reference) |
| `audit_log` | `ip = NULL` on rows where the user is the actor |
| `ratings` | `signature = NULL` (an EIP-712 signature identifies the signer) |
| `kyb_submissions` (**Built**, TASK-008c-3) | a `PENDING` submission of the user is closed: `REJECTED` without a note, `reviewed_at = now`, no reviewer; a claim puts the imported organisation back to `NONE`, a new organisation becomes `REJECTED` (an organisation approved earlier stays `APPROVED`); audit `kyb.closed_on_erase` with the submission id only. Other submissions and every `review_note` stay (the note describes the organisation, not the person) |
| `private_files` (**Built**, TASK-008c-3, ADR-034) | `deleted_at` set on the user's unattached files and on the files of their non-approved submissions; files of **approved** submissions stay (the organisation's proof of verification). `eraseUser` returns the storage keys; the account route deletes those objects **after** the commit, and an object that cannot be deleted is left for `files:sweep` (its row is already marked) |

`kyb_submissions.private_file_keys[]` is unused and superseded by `private_files.kyb_submission_id`; a later migration may drop it.

**Organisation data before approval (TASK-008b-1, Built).** For a *new* organisation the `organizations` row is created from the form (`source = REGISTERED`, `kyb_status = PENDING`; not public while pending). For a *claim* of an imported organisation and for a *resubmission* after a rejection the `organizations` row is **not** changed apart from `kyb_status = PENDING`: the submitted data lives in `kyb_submissions.application`, and the review (**Built**, TASK-008c-1) applies it to the row on approval — for a claim together with `source = REGISTERED` and `claimed_by_user_id`. A rejected *new* organisation becomes `REJECTED`; a rejected *claim* puts the imported organisation back to `NONE`, unchanged, and removes the claimant's `org_members` row, so a false claim never marks a real charity as rejected. The applicant's status page therefore reads the user's own `kyb_submissions`, not memberships. Sources: `packages/db/src/schema/organizations.ts`, `apps/web/src/lib/organizations/apply.ts`, `docs/tasks/TASK-008b1.feedback.md`.

Kept, **pseudonymous by `user_id`**: `points_ledger`, `ratings` (stars and comment, needed for the org Trust Score), `audit_log` rows (without IP), and the `users` row itself. Because `privy_did` is null afterwards, any existing session cookie of that user stops working (`getSession()` treats it as logged out). Rows where the erased user is only the *subject* (`entity_id`) of another actor's action keep that actor's IP — deliberate, see TASK-005 feedback. On-chain data cannot be erased; the platform never puts personal data on chain or on IPFS (ADR-014).

Sources: `packages/db/src/schema/*.ts`, `packages/db/src/migrate.ts`, `packages/db/src/seed.ts`, `packages/db/src/gdpr.ts`, `packages/db/package.json`, `Dockerfile`, `.github/workflows/deploy.yml`, `docs/tasks/TASK-005.feedback.md`, `docs/tasks/TASK-025.feedback.md`, `docs/02-ARCHITECTURE.md` §4.4, §5.3.

---

### 2.5 How the web app reads `chain` (**Live on dev**, TASK-010c)

The first reader of the indexer's views is the campaign linking (`apps/web/src/lib/campaigns/publish.ts`). It selects columns by name from `chain.campaign`: `address`, `beneficiary`, `beneficiary_type`, `target::text`, `deadline::text`, `state::text`, `tx_hash`, `block_time::text`. It never references the per-deploy enum type (`chain_<sha7>.campaign_state`), so a new indexer deploy does not break it. Hex values are compared lowercase. A database without the `chain` schema (local, or before the indexer runs) answers "indexer unavailable" instead of an error.

Sources: `apps/web/src/lib/campaigns/publish.ts`, `apps/web/src/__tests__/campaign-publish.test.ts` (simulates the view with a table of the same columns).

**Public campaign pages (Live on dev, TASK-011a, PR #50)** — `apps/web/src/lib/campaigns/public.ts`, same rules (columns by name, `::text` casts, lowercase hex, `isMissingRelation` → page renders from `app.*` with a notice instead of a 500):
- `listPublicCampaigns` / `getPublicCampaign`: `app.campaigns` (`status = 'DEPLOYED'`, `onchain_address` set) ⨝ `app.organizations` ⨝ latest COVER in `app.campaign_media`, `left join chain.campaign` on the address for `state`, `deadline`, `total_raised`, `payout_mode`, `end_time`, plus `count(*)` from `chain.campaign_donor`. A DEPLOYED campaign the indexer has not seen yet shows without figures.
- `listCampaignDonations`: `chain.donation` newest first (`block_number desc, log_index desc`), `left join app.user_addresses` on the lowercase donor → `app.users` (`display_name`, `anonymous_donations`). ADR-043: name, "Anonymous", or (no match — also after `eraseUser`, which deletes `user_addresses`) the address. The anonymous user's name never leaves the server.
- Display state: `LIVE` before the deadline = live; `LIVE` after it = "ending" (waits for `finalize()`); `PAYING` shows as succeeded; unknown values = pending.
- **Donating (Live on dev, TASK-011b, PR #55)** — two more readers in the same file:
  - `listDonationThemes`: Emergency Pool themes for the failure preference = `app.emergency_subpools` (pool 0 excluded — it is the general pool, always offered) ⨝ `chain.pool` on `pool_id = id`, so only sub-pools that exist on chain are offered. Empty without the views.
  - `listMyDonations(userId, campaign)`: `chain.campaign_donor` (`donated > 0`) ⨝ `app.user_addresses` of that user → per address `donated`, `preference` (0 = refund, 1 = Emergency Pool), `sub_pool_id`. Served only to the logged-in user by `GET /api/donations/[campaign]` (401 without a session, 400 for a malformed address, 503 without the views). The donate panel's "remaining" figure comes from `chain.campaign.total_raised`; the transaction itself re-reads `remaining()` through the donor's wallet.
- Tests simulate the views with tables (`apps/web/src/__tests__/helpers/fake-chain.ts`, shared by the vitest and Playwright suites and serialised with an advisory lock).

## 3. The indexer in plain words

The smart contracts emit an **event** every time something happens: a campaign is created, someone donates, a vote is cast, money is refunded. Reading the contracts directly for every page view would be slow and expensive. The indexer (`apps/indexer`, Ponder) listens to these events from the chain's RPC endpoint, in block order, and turns them into ordinary database rows — one table for campaigns, one for donations, one for votes and so on. Each handler updates the rows exactly the way the contract updates its own storage, so a row always equals what the contract would answer at the same block. A separate check (**reconcile**) proves that after every deploy.

Status: **Live on dev** since 2026-10-01. Merged in PR #15 (Campaign) and PR #16 (Emergency Pool); deployed with PR #17 (TASK-026). In the successful deploy (GitHub Actions run 36923510353 (Deploy, `dev`, 2026-10-01)) the indexer backfilled amoy-dev from its start block and reported `/ready` about 3½ minutes after the container started; reconcile then reported `checked=4 mismatches: 0` and prune `live=chain_d991cb3`. The CI job "Indexer scenario" is green on `dev`. uat and prod have no indexer yet.

Sources: `apps/indexer/src/index.ts`, `apps/indexer/src/pool.ts`, `docs/tasks/TASK-006.feedback.md`, `docs/tasks/TASK-026.feedback.md`.

---

## 4. Indexer details

### 4.1 Version and runtime

- **Ponder 0.17.12** (exact pin), viem 2, Hono for the custom API, Node 22.
- One chain per indexer instance; each environment runs its own indexer (ADR-020).
- Image `Dockerfile.indexer` runs `ponder start --schema chain_${GIT_SHA7} --views-schema chain`. `GIT_SHA7` is a build argument baked into the image, so a rollback to an older image automatically uses that image's schema.
- **RPC provider:** Alchemy, pay-as-you-go plan. The free tier limits `eth_getLogs` to 10-block ranges and throttles compute units per second; on it the first Amoy backfill stalled. Every environment needs a paid RPC plan that allows `eth_getLogs` over ranges of at least ~1,000 blocks.
- Kamal service `cherrio-indexer-<env>` (`config/indexer.yml` + `config/indexer.<env>.yml`), no proxy route, no published port, memory limit 384 MB (`NODE_OPTIONS=--max-old-space-size=288`), Docker health check on Ponder `/health`. Reachable only inside the `kamal` Docker network as `cherrio-indexer-dev:42069`.

### 4.2 Configuration by `APP_ENV`

`apps/indexer/lib/env.ts` → `resolveIndexerEnv()` throws on anything missing ("an indexer must never start half-configured"):

| Input | `APP_ENV=local` | `APP_ENV=dev` / `uat` / `prod` |
|---|---|---|
| Chain id and contract addresses + `startBlock` | JSON file from `INDEXER_DEPLOYMENT_FILE` (written by the deploy script) | `@cherrio/shared` → `getChainConfig(env)` and `requireContracts(env)` (deployments `amoy-dev`, `amoy-uat`, `polygon`) |
| RPC URL | `PONDER_RPC_URL_<chainId>` (e.g. `PONDER_RPC_URL_80002` for Amoy, `PONDER_RPC_URL_137` for Polygon). The URL contains the provider key, so the indexer, reconcile and prune filter it out of everything they print (`lib/redact.ts`, shown as `…/v2/***`) | same |
| Database | `DATABASE_URL_DIRECT` — PgBouncer URLs refused | same; on the server it is the indexer role's direct URL (GitHub secret `INDEXER_DATABASE_URL`) |
| RPC cache | disabled (`disableCache`), so Anvil data never lands in `ponder_sync` | enabled |
| Block polling interval | 1 s | **15 s** by default (since 2026-10-04, PR fix/indexer-polling-keeps-up). Ponder's realtime sync fetches **at most 50 missing blocks per poll** (`MAX_QUEUED_BLOCKS`), so the interval caps how many blocks a minute the indexer can follow. Amoy makes ~60 blocks a minute (measured 2026-10-04): the 60 s interval used from 2026-10-03 let the indexer fall ~10 blocks behind every minute — 6,764 blocks (2 h 20 min) after 12 h, and David's sponsored donation did not show. Optional override `INDEXER_POLLING_INTERVAL_MS` (integer, **1,000–25,000**; anything else stops the indexer at start, so it can never be set too slow again). RPC cost scales with blocks (each is fetched once), not with polls: 15 s adds ~4,300 "latest block" calls a day compared with 60 s. A new donation appears in `chain.*` within about one interval plus finality. |

Indexed contracts (`ponder.config.ts`): `CampaignFactory` (fixed address), `Campaign` (every clone, discovered through the factory's `CampaignCreated(campaign)` parameter), `EmergencyPool` (fixed address). Each starts at its deployment `startBlock`. `PlatformConfig` events and OpenZeppelin's `Initialized` are deliberately not indexed.

### 4.3 Event → handler → table

23 events plus one setup handler. Handlers live in `src/index.ts` (factory and campaigns) and `src/pool.ts` (Emergency Pool). Every event row also stores `tx_hash`, `log_index`, `block_number`, `block_time` (`lib/origin.ts`).

| Contract | Event | Writes |
|---|---|---|
| CampaignFactory | `CampaignCreated` | insert `campaign` (state `LIVE`, all counters 0) |
| Campaign | `Donated` | insert `donation`; upsert `campaign_donor` (adds to `donated`); `campaign.total_raised +=`; when the donor is the Emergency Pool also `campaign.pool_donated +=` (and the donor's `sub_pool_id` is left unchanged) |
| Campaign | `PreferenceSet` | update `campaign_donor.preference`, `sub_pool_id` |
| Campaign | `Finalized` | `campaign.state`, `end_time`; if `FAILED` also `settlement_start` |
| Campaign | `PayoutModeSet` | `campaign.payout_mode` (0 SINGLE, 1 MILESTONES) |
| Campaign | `TrancheReleased` | insert `tranche_release`; `campaign.released +=`, `fee_paid +=`; MILESTONES: `tranches_released + 1`; state `COMPLETED` (SINGLE, or 3rd tranche) else `PAYING` |
| Campaign | `EvidenceSubmitted` | insert `vote_round`; `campaign.state = VOTING`, `current_round`, `vote_end` |
| Campaign | `Voted` | insert `vote`; `vote_round.yes_votes` / `no_votes +=` weight |
| Campaign | `VoteClosed` | `vote_round` final votes, `outcome`, `closed_at`; `campaign.state`; if `REJECTED` also `rejected_remainder` (= raised − released − fees) and `settlement_start` |
| Campaign | `Frozen` | insert `guardian_action` (FREEZE); `campaign.state = FROZEN`, `prev_state`, `frozen_at` |
| Campaign | `Resolved` | insert `guardian_action` (RESOLVE); `campaign.state`; unfreezing a vote extends `vote_end` (campaign and current `vote_round`) by the time spent frozen; a rejection sets `rejected_remainder`, `settlement_start` |
| Campaign | `Refunded` | insert `refund`; `campaign_donor.settled = true`; `campaign.total_refunded +=` |
| Campaign | `SentToPool` | `campaign_donor.settled = true`; `campaign.total_sent_to_pool +=` (the `pool_transfer` row comes from `CampaignInflow`) |
| Campaign | `Swept` | `campaign.swept = true`; `total_sent_to_pool +=` |
| EmergencyPool | `setup` (no event) | insert `pool` id 0 — the constructor creates the general pool without an event |
| EmergencyPool | `SubPoolCreated` | insert `pool` |
| EmergencyPool | `PoolDonated` | insert `pool_contribution` (DIRECT); `pool.balance +=`, `total_contributed +=` |
| EmergencyPool | `CampaignInflow` | insert `pool_transfer` (SETTLE, or SWEEP when the donor is the zero address); `pool.balance +=`; non-zero donor: insert `pool_contribution` (CAMPAIGN) and `total_contributed +=` (a sweep gives nobody voting weight) |
| EmergencyPool | `AllocationProposed` | insert `allocation` (VOTING); `pool.balance -= amount` (reserved); `campaign.funding_pool_id` if still empty |
| EmergencyPool | `AllocationVoted` | insert `allocation_vote`; `allocation.yes_votes` / `no_votes +=` |
| EmergencyPool | `AllocationClosed` | `allocation.state`; PASSED: `delivered` from the receipt and `pool.balance += amount − delivered`; REJECTED: `pool.balance += amount`; NEEDS_REVIEW keeps the amount reserved |
| EmergencyPool | `AllocationDeliveryFailed` | `allocation.state = DELIVERY_FAILED`; `pool.balance += amount` |
| EmergencyPool | `AllocationResolved` | insert `guardian_action` (ALLOCATION_RESOLVE); `allocation.state`; RESOLVED_PASS: `delivered` from the receipt, `pool.balance += amount − delivered`; RESOLVED_REJECT: `pool.balance += amount` |
| EmergencyPool | `ReclaimedFromCampaign` | insert `pool_transfer` (RECLAIM); `pool.balance +=` on the campaign's funding pool, or pool 0 |

### 4.4 Indexer tables (`ponder.schema.ts`)

All amounts are USDC base units (6 decimals) as `bigint`; addresses are lowercase hex. State enums use the same order as the Solidity enums.

| Table | Key | Content |
|---|---|---|
| `campaign` | `address` | Mirror of `Campaign` storage: ids, beneficiary, target, deadline, `state`, `total_raised`, `payout_mode`, `released`, `fee_paid`, `tranches_released`, `current_round`, `vote_end`, `end_time`, `total_refunded`, `total_sent_to_pool`, `pool_donated`, `swept`, `prev_state`, `frozen_at`, `settlement_start`, `rejected_remainder`, `funding_pool_id` |
| `campaign_donor` | (`campaign`, `donor`) | `donated`, `preference` (0 REFUND, 1 EMERGENCY_POOL), `sub_pool_id`, `settled` |
| `donation` | event id | One row per `Donated` event |
| `vote_round` | (`campaign`, `round`) | `bundle_hash`, `vote_end`, yes/no votes, `outcome`, `closed_at` |
| `vote` | (`campaign`, `round`, `voter`) | `approve`, `weight` |
| `tranche_release` | event id | `tranche_index`, `beneficiary`, `amount`, `fee` |
| `refund` | event id | `donor`, `amount` |
| `guardian_action` | event id | `kind` (FREEZE / RESOLVE / ALLOCATION_RESOLVE), `campaign`, `allocation_id`, `actor` (tx sender), `approve`, `result_state` |
| `pool` | `id` | `balance` (= `poolBalance(id)`), `total_contributed` |
| `pool_contribution` | event id | `pool_id`, `donor`, `amount`, `source` (DIRECT / CAMPAIGN), `campaign` |
| `pool_transfer` | event id | `kind` (SETTLE / SWEEP / RECLAIM), `pool_id`, `campaign`, `donor`, `amount` |
| `allocation` | `id` | `pool_id`, `campaign`, `amount`, `delivered`, `reason_hash`, votes, `vote_end`, `proposal_block`, `state` |
| `allocation_vote` | (`allocation_id`, `voter`) | `approve`, `weight` |

### 4.5 Delivered allocation amounts (from the transaction receipt)

When an allocation passes, the campaign may take less than the allocated amount (it clips to its remaining target). The contract's `getAllocation(id)` has no "delivered" field and a balance read is end-of-block, so the indexer reads the number from the **transaction receipt**:

1. The `AllocationClosed` (PASSED) and `AllocationResolved` (RESOLVED_PASS) handlers call `context.client.getTransactionReceipt` (cached by Ponder; only for delivered allocations). Ponder's own `event.transactionReceipt` is not used because it carries no logs.
2. `lib/delivered.ts` → `deliveredFromLogs()` looks for the `Donated` log that was emitted by the allocation's campaign, has the Emergency Pool as donor, and has a lower `logIndex` than the allocation event. The last such log wins. Logs that do not decode as a Campaign `Donated` event are skipped.
3. If no such log exists the handler **throws and the indexer stops** — it never assumes the full amount or zero.
4. The result is stored in `allocation.delivered`; `amount − delivered` goes back to `pool.balance`.

### 4.6 Reorgs and finality

- Ponder handles reorgs inside its finality window itself. Finality is hard-coded in Ponder: **30 blocks on Amoy** (accepted), **200 on Polygon** (to be reviewed in TASK-023).
- A deeper reorg stops the indexer and needs a re-index (CHEATSHEET §10.4: drop the `chain_<sha7>` schema and restart; `ponder_sync` stays, so it is fast).
- `/ready` returns 200 when the backfill has reached the finalized block; the last ~30 blocks are processed right after.
- After a crash or restart the instance resumes from its checkpoint ("Detected crash recovery" in the log).

### 4.7 Reconcile

`pnpm --filter indexer reconcile` (`scripts/reconcile.ts`, `lib/reconcile.ts`; in the image `node dist/reconcile.mjs`).

- **At which block:** it reads Ponder's `latest_checkpoint` from `_ponder_checkpoint` (through the schema it checks, default `chain`; override `RECONCILE_SCHEMA`), extracts the block number from the 75-digit checkpoint, and makes **every** contract call with `blockNumber` = that block. A moving chain therefore cannot produce false mismatches. It expects exactly one indexed chain.
- **What it compares:**
  - `campaign`: 19 columns against the view functions of the same name, plus `state`, `prev_state`, `payout_mode` (and whether it is set), `factory.isCampaign(address)`, `factory.campaigns(offchainId) == address`, `funding_pool_id` against `EmergencyPool.hasFundingPool` / `fundingPool`, and `sum(allocation.delivered)` against `Campaign.poolDonated()`.
  - latest `vote_round` per campaign: round number, yes/no votes, `vote_end`.
  - `campaign_donor`: `donated`, `preference`, `donorSubPoolId`, `settled`.
  - `vote`: `hasVoted(voter, round)`, and `weight == donated[voter]`.
  - `pool`: `poolExists`, `poolBalance`, `totalContributedAt(id, block)`.
  - `pool_contribution`: sum per (pool, donor) against `contributedAt(pool, donor, block)`.
  - `allocation`: row count against `allocationCount()`, and each row's fields against `getAllocation(id)`.
  - `allocation_vote`: `hasVotedAllocation(id, voter)`.
  - Event-log tables (`donation`, `refund`, `tranche_release`, …) are covered through the sums they feed.
- **How it fails a deploy:** each difference prints `MISMATCH <table> <key> <field>: indexed=… onchain=…`, then a summary `reconcile: schema=chain block=… checked=… mismatches: N`. Exit code is 1 when N > 0. The deploy job runs reconcile inside the new container after `/ready`; a non-zero exit fails the job.
- **Limit:** reconcile cannot find a campaign the indexer never saw (the factory has no campaign list).

### 4.8 Prune

`pnpm --filter indexer prune [-- --dry-run]` (`scripts/prune.ts`, `lib/prune.ts`; in the image `node dist/prune.mjs`). Runs as the last step of the deploy job.

- **Keeps:** the schema the `chain` views currently read from (found through Postgres view dependencies, not by name; refuses if the views read from more than one schema), the most recently active other schema (one previous version, for rollback), and any instance whose Ponder heartbeat is younger than 2 minutes (treated as still running).
- **Drops:** older `chain_<id>` schemas that contain a `_ponder_meta` table. It can only ever drop names matching `^chain_[a-z0-9]+$`, never `app`, `chain`, `ponder_sync` or `public`, and re-checks every name before `DROP SCHEMA … CASCADE`.
- `ponder db prune` is **not** used: it drops every stopped instance's schema, including the previous one kept for rollback (TASK-026 finding).

### 4.9 Read endpoints

`src/api/index.ts` adds two read-only endpoints to Ponder's own `/health`, `/ready`, `/status`, `/metrics`:

- `/sql/*` — Ponder SQL client over HTTP
- `/graphql` — Ponder GraphQL

They are **internal only**: the container publishes no port and has no kamal-proxy route, so they are reachable only inside the server's Docker network (`cherrio-indexer-<env>:42069`). From outside, `https://dev.cherr.io/sql` and `/graphql` must return the web app's 404. No consumer uses them yet (Planned: the web app may call them later).

### 4.10 Connection budget

Postgres `max_connections = 100`; every role has a hard `CONNECTION LIMIT` (`infra/shared/ensure-databases.sh`, `infra/shared/indexer-role.sql`):

| Per environment | Connections |
|---|---|
| Web role `cherrio_<env>` limit | 18 (PgBouncer pool 14 + reserve 2 + 2 direct for migrations / GDPR erase) |
| Indexer role `cherrio_indexer_<env>` limit | 10 |
| Ponder `poolConfig.max` | 5 (Ponder uses 2 internal + pools of (max − 2) / 3, plus 1 LISTEN connection); measured 5 at start, 2 idle |
| Old + new indexer during a deploy | 7 measured locally, theoretical worst case 12 (Kamal starts the new container before stopping the old one) |
| Reconcile, prune | 1 each |

Total: 3 × (18 + 10) = 84, plus 6 for superuser / backup / maintenance = **90 of 100**. If a deploy ever fails with "too many connections for role cherrio_indexer_dev", stop the old container first and re-run (CHEATSHEET §10.4). Status: Live on dev — applied with `ensure-databases.sh` before the first indexer deploy (TASK-026).

### 4.11 Database roles and privileges

| Role | Can | Cannot |
|---|---|---|
| `cherrio_indexer_<env>` (created only when `POSTGRES_INDEXER_<ENV>_PASSWORD` is set) | `CONNECT` and `CREATE` on its own database; owns schema `chain` (pre-created by `indexer-role.sql`), creates `chain_<sha7>` and `ponder_sync` | anything on schema `app` (select, insert, update, delete, create — "permission denied for schema app"; drop — "must be owner"); connect through PgBouncer (not in `userlist.txt`) |
| `cherrio_<env>` (web) | owns `app`; `USAGE` on `chain` and `SELECT` on every view in it — also views a later deploy re-creates, through `ALTER DEFAULT PRIVILEGES FOR ROLE <indexer> IN SCHEMA chain GRANT SELECT ON TABLES` | write to `chain` views; read `chain_<sha7>` or `ponder_sync` directly |

Ponder only runs `CREATE SCHEMA IF NOT EXISTS` for `chain`, so the pre-created schema keeps its oid, owner and default privileges across deploys; no grant step is needed in the deploy job (proven locally over three consecutive deploys, TASK-026).

### 4.12 Deploy job (indexer)

`.github/workflows/deploy.yml`, jobs `indexer-changes` (path filter on `apps/indexer`, `packages/contracts`, `packages/shared`, `pnpm-lock.yaml`, `Dockerfile.indexer`, `config/indexer*.yml`, the workflow; or manual `workflow_dispatch`) and `indexer`: build → push to GHCR → Kamal deploy → wait for `/ready` (20 min timeout, prints the last 100 log lines on timeout) → reconcile → prune. Independent of the web job; skipped for an environment without `config/indexer.<env>.yml` (uat, prod today). Rollback: `kamal rollback -c config/indexer.yml -d dev sha-<previous>`; the previous schema is still there, so the views switch back when it is ready. Status: **Live on dev** — first successful run 2026-10-01 (GitHub Actions run 36923510353 (Deploy, `dev`, 2026-10-01): deploy → ready → reconcile → prune all green). The first attempt (PR #17 merge) failed at the Kamal deploy step; a change to `.kamal/secrets-common` was not picked up by the path filter, which was then extended to that file (commit `d991cb3`). A second deploy that proves prune keeps the previous schema (`kept=[chain_d991cb3]`) is still to be checked.

Sources: `apps/indexer/ponder.config.ts`, `apps/indexer/ponder.schema.ts`, `apps/indexer/src/index.ts`, `apps/indexer/src/pool.ts`, `apps/indexer/src/api/index.ts`, `apps/indexer/lib/env.ts`, `apps/indexer/lib/origin.ts`, `apps/indexer/lib/delivered.ts`, `apps/indexer/lib/reconcile.ts`, `apps/indexer/lib/prune.ts`, `apps/indexer/scripts/reconcile.ts`, `apps/indexer/scripts/prune.ts`, `apps/indexer/package.json`, `infra/shared/indexer-role.sql`, `infra/README.md`, `docs/tasks/TASK-006.feedback.md`, `docs/tasks/TASK-026-indexer-deploy.md`, `docs/tasks/TASK-026.feedback.md`, `docs/CHEATSHEET.md` §10, `docs/03-DECISIONS.md` (ADR-020, ADR-026).

---

## 5. Data flow

```mermaid
flowchart LR
  subgraph Chain["Polygon (Amoy for dev/uat)"]
    F[CampaignFactory]
    C[Campaign clones]
    P[EmergencyPool]
  end

  RPC[(RPC provider<br/>PONDER_RPC_URL_chainId)]
  F -- events --> RPC
  C -- events --> RPC
  P -- events --> RPC

  subgraph Indexer["cherrio-indexer-env (Ponder 0.17.12, no public port)"]
    H[Handlers<br/>src/index.ts, src/pool.ts]
    R[reconcile<br/>after /ready]
    PR[prune]
  end
  RPC -- logs, receipts --> H
  RPC -- view calls at indexed block --> R

  subgraph PG["Postgres 16 — database cherrio_env"]
    SYNC[(ponder_sync<br/>RPC cache)]
    CS[(chain_sha7<br/>13 tables)]
    V[(chain<br/>read-only views)]
    APP[(app<br/>Drizzle tables)]
  end

  H -- direct connection<br/>indexer role --> CS
  H <--> SYNC
  CS --> V
  R -- reads --> V
  PR -- drops old chain_sha7 --> CS

  subgraph Web["cherrio-web-env (Next.js)"]
    W[Pages and API routes]
  end
  W -- PgBouncer<br/>web role, read/write --> APP
  W -. SELECT only, planned .-> V
```

Sources: as in §1 and §4.

---

## 6. Open points

- Reconcile cannot detect a campaign the indexer never saw (no on-chain campaign list).
- The first real Amoy backfill reached `/ready` in about 3½ minutes, well inside the 20-minute timeout. The second deploy (2026-10-02, GitHub Actions run 36973809232) was verified on the server: the `chain` views switched to the new schema and prune kept the previous one (`live=chain_31a0a61 kept=[chain_d991cb3]`). Memory after that deploy, at idle, was 165 MiB of the 384 MiB limit; memory during a backfill has not been measured.
- A full re-index needs a paid RPC plan (`eth_getLogs` ranges ≥ ~1,000 blocks) and gets slower as the chain grows.
- The RPC URL, which contains the provider key, appeared in Ponder's logs during the first deploys (viem puts the URL into its error messages). Since TASK-027 the indexer, reconcile and prune mask the key in all their output; this is **Built** and goes live with the next indexer deploy. The key itself is **not rotated** (decision 2026-10-02, David; the account is on pay-as-you-go).
- The masking filters `stdout`/`stderr` of the process. Ponder's JSON log format bypasses that, so the indexer refuses to start with `--log-format json`.
- A `DELIVERY_FAILED` reached through `resolveAllocation` emits no `AllocationResolved`, so it leaves no `guardian_action` row (contract behaviour).

Sources: `docs/tasks/TASK-006.feedback.md` (Open questions), `docs/tasks/TASK-026.feedback.md` (Open questions), `docs/tasks/TASK-026.feedback.md` (Server results), `docs/tasks/TASK-027.feedback.md`, `apps/indexer/lib/redact.ts`, GitHub Actions run 36923510353 (Deploy, `dev`, 2026-10-01).
