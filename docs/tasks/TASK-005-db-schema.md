# TASK-005 — DB package: Drizzle schema, migrations, seed

Can run in parallel with TASK-002..004. Read first: `docs/02-ARCHITECTURE.md` §4.4, `docs/01-PRODUCT-SPEC.md` §1, §3, §4.

## Scope
- In `packages/db`, schema `app` (Postgres schema, not public). Ponder will own schema `chain` — do not create chain tables.
- Tables (UUID v7 PKs, `created_at`/`updated_at` timestamptz, soft delete only where noted):
  - `users` (display_name, email nullable, privy_did nullable unique, locale default 'en', anonymous_donations bool)
  - `user_addresses` (user_id, address lowercase unique, kind: `EMBEDDED|SMART_ACCOUNT|EXTERNAL`, is_primary)
  - `user_roles` (user_id, role: `PLATFORM_ADMIN|ORG_ADMIN|ORG_MEMBER`, org_id nullable)
  - `organizations` (source `REGISTERED|IMPORTED`, name, legal_name, country ISO-2, registry `SI_AJPES|SI_MJU|UK_CC|US_IRS|NONE`, registry_id, website, description, causes text[], kyb_status `NONE|PENDING|APPROVED|REJECTED`, claimed_by_user_id, payout_address, logo_cid) — unique (registry, registry_id)
  - `org_members` (org_id, user_id, role)
  - `kyb_submissions` (org_id, submitted_by, status, reviewer_id, review_note, private_file_keys text[]) 
  - `kyc_checks` (user_id, provider 'SUMSUB', applicant_id, status, level, reviewed_at) — **no document data**
  - `campaigns` (offchain_id bytea unique, org_id nullable, starter_user_id, beneficiary_type, title, slug unique, story jsonb, cause, country, target_eur_cents bigint, eur_usd_rate numeric(18,8), rate_source, rate_at, target_usdc numeric(78,0), duration_days, status `DRAFT|PENDING_REVIEW|REJECTED|APPROVED|DEPLOYED`, review_note, onchain_address nullable unique)
  - `campaign_media` (campaign_id, kind `COVER|GALLERY|VIDEO`, cid, storage `POLLINATIONX|PINATA`, sort)
  - `evidence_bundles` (campaign_id, round, bundle_hash bytea, private_file_keys text[], public_cids text[], status)
  - `ratings` (org_id, campaign_id, user_id, stars 1–5, comment, signature) unique (campaign_id, user_id)
  - `points_ledger` (user_id, bucket `STATUS|REWARD`, delta int, reason enum, ref_type, ref_id, rule_version, voided_at, voided_reason) — append only
  - `user_levels` (user_id pk, level, status_points, reward_points, last_activity_at)
  - `trust_scores` (org_id, version, score numeric(5,2), components jsonb, computed_at) + index (org_id, computed_at desc)
  - `registry_records` (registry, registry_id, raw jsonb, fetched_at) unique (registry, registry_id)
  - `emergency_subpools` (pool_id int unique, slug, name_key (i18n key), description_key)
  - `onramp_orders` (user_id, provider 'TRANSAK', provider_order_id unique, status, fiat_amount_cents, fiat_currency, usdc_amount numeric(78,0), wallet_address, campaign_id nullable)
  - `audit_log` (actor_user_id, action, entity_type, entity_id, data jsonb, ip)
- Enable `vector` extension in first migration (no vector columns yet).
- All USDC amounts `numeric(78,0)` mapped to `bigint` in TS via custom Drizzle type. EUR in integer cents.
- Seed script: 1 platform admin (from env), 5 sub-pools (general, medical, disasters, animals, climate), 3 imported sample orgs.
- Export typed client `createDb(url)` and inferred types.

## Tests
- Vitest integration tests against the dev Postgres: migrations apply from zero, seed runs twice idempotently, bigint round-trip for max uint256.

## Must not touch
`docs/**`, `packages/contracts/**`.

## Acceptance criteria
- `pnpm --filter db migrate && pnpm --filter db seed` work on a fresh DB.
- ER diagram (mermaid) in feedback.
